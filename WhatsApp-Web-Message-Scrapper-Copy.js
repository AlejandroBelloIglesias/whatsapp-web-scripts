// ==UserScript==
// @name         WhatsApp Web Message Scrapper Copy
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Copy all whatsapp web messages in a chat from a selected one to the latest or up to a date and time threshold.
// @author       Alejandro Bello Iglesias
// @match        https://web.whatsapp.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=whatsapp.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const SELECTORS = {
        messageRow: 'div[data-id]',
        copyableText: '.copyable-text',
        readMoreBtn: '[role="button"]'
    };

    const Scraper = {
        isScraping: false,
        buffer: [],
        seenIds: new Set(),
        nameMap: new Map(),
        panelUi: null,
        counterUi: null,
        limitTimestamp: null,
        reachedLimit: false,

        start(startId, limitTime) {
            try {
                this.isScraping = true;
                this.reachedLimit = false;
                this.limitTimestamp = limitTime;
                this.buffer = [];
                this.seenIds.clear();
                this.nameMap.clear();
                this.showPanel();
                this.updateCounter(0);

                console.log(`[SCRAPER-DEBUG] 🚀 Iniciando recolección desde ID: ${startId}`);
                if (limitTime) console.log(`[SCRAPER-DEBUG] ⏱️ Límite temporal establecido: ${new Date(limitTime).toLocaleString()}`);

                this.scrapeLoop(startId);
            } catch (err) {
                console.error("[SCRAPER ERROR CRÍTICO al iniciar]:", err);
            }
        },

        stopAndShowResult() {
            this.isScraping = false;
            if (this.buffer.length === 0) {
                console.warn("[SCRAPER-DEBUG] El buffer está vacío, no hay nada que mostrar.");
                this.hidePanel();
                return;
            }

            const finalString = this.buffer.join('\n\n');

            if (this.reachedLimit) {
                this.counterUi.innerText = `🛑 Límite de tiempo alcanzado. ${this.buffer.length} mensajes. Cópialos a mano:`;
            } else {
                this.counterUi.innerText = `✅ Extraídos ${this.buffer.length} mensajes. Cópialos a mano:`;
            }
            this.counterUi.style.color = '#25D366';

            const stopBtn = this.panelUi.querySelector('#scraper-stop-btn');
            if (stopBtn) stopBtn.remove();

            this.panelUi.style.width = '600px';
            this.panelUi.style.maxWidth = '90vw';

            const textarea = document.createElement('textarea');
            textarea.value = finalString;
            textarea.style.cssText = `width: 100%; height: 350px; resize: vertical; background: #111b21; color: #d1d7db; border: 1px solid #2a3942; border-radius: 8px; padding: 10px; font-family: monospace; font-size: 13px; margin-bottom: 10px; outline: none; box-sizing: border-box; white-space: pre-wrap;`;
            textarea.readOnly = true;

            textarea.onclick = () => {
                textarea.focus();
                textarea.select();
            };

            const closeBtn = document.createElement('button');
            closeBtn.innerText = '✖️ Cerrar Panel';
            closeBtn.style.cssText = `background:#ea4335; color:white; border:none; padding: 10px 20px; border-radius: 8px; font-weight:bold; cursor:pointer; width: 100%; transition: background 0.2s; font-size: 14px;`;
            closeBtn.onclick = () => {
                this.hidePanel();
                if (this.panelUi) {
                    this.panelUi.remove();
                    this.panelUi = null;
                    this.counterUi = null;
                }
            };

            this.panelUi.appendChild(textarea);
            this.panelUi.appendChild(closeBtn);

            textarea.focus();
            textarea.select();

            console.log(`[SCRAPER-DEBUG] ✅ Resultados mostrados.`);
        },

        async scrapeLoop(startId) {
            let lastProcessedId = startId;
            let stuckCount = 0;

            const startNode = document.querySelector(`div[data-id="${startId}"]`);
            if (startNode) {
                await this.processNode(startNode);
                if (this.reachedLimit) {
                    this.stopAndShowResult();
                    return;
                }
                startNode.scrollIntoView({ block: 'center', behavior: 'auto' });
                await new Promise(r => setTimeout(r, 200));
            }

            while (this.isScraping) {
                const nodes = Array.from(document.querySelectorAll(SELECTORS.messageRow));
                let foundNew = false;

                let startIndex = 0;
                const lastIdx = nodes.findIndex(n => n.getAttribute('data-id') === lastProcessedId);

                if (lastIdx !== -1) {
                    startIndex = lastIdx;
                }

                for (let i = startIndex; i < nodes.length; i++) {
                    const node = nodes[i];
                    const id = node.getAttribute('data-id');

                    if (!this.seenIds.has(id)) {
                        await this.processNode(node);
                        if (this.reachedLimit) {
                            console.log(`[SCRAPER-DEBUG] 🛑 Límite temporal cruzado. Finalizando bucle.`);
                            this.stopAndShowResult();
                            return;
                        }
                        lastProcessedId = id;
                        foundNew = true;
                    }
                }

                if (foundNew) {
                    stuckCount = 0;
                    const lastNode = document.querySelector(`div[data-id="${lastProcessedId}"]`);
                    if (lastNode) {
                        lastNode.scrollIntoView({ block: 'end', behavior: 'auto' });
                    }
                    await new Promise(r => setTimeout(r, 150));
                } else {
                    stuckCount++;
                    if (stuckCount > 8) {
                        console.log(`[SCRAPER-DEBUG] 🏁 Fin del chat detectado.`);
                        this.stopAndShowResult();
                        break;
                    }
                    await new Promise(r => setTimeout(r, 250));
                }
            }
        },

        resolveSenderName(rawSender, row) {
            if (this.nameMap.has(rawSender)) return this.nameMap.get(rawSender);

            let current = row;
            while (current) {
                const textCont = current.querySelector(SELECTORS.copyableText);
                if (textCont) {
                    const pt = textCont.getAttribute('data-pre-plain-text');
                    if (pt) {
                        const m = pt.match(/^\[(.*?)\]\s*(.*?):/);
                        const iterSender = m ? m[2].trim() : null;

                        if (iterSender === rawSender) {
                            const authorNode = current.querySelector('[data-testid="author"]');
                            if (authorNode) {
                                let name = authorNode.textContent.trim();
                                name = name.replace(/^~\s*/, '');
                                this.nameMap.set(rawSender, name);
                                return name;
                            }
                        } else if (iterSender && iterSender !== rawSender) {
                            break;
                        }
                    }
                }
                current = current.previousElementSibling;
            }

            this.nameMap.set(rawSender, rawSender);
            return rawSender;
        },

        parseWhatsAppDate(dateStr) {
            try {
                // dateStr ej: "11:04 a. m., 14/6/2026"
                const parts = dateStr.split(',').map(s => s.trim());
                if (parts.length < 2) return null;

                let timeStr = parts[0];
                let datePart = parts[1];

                // Si están invertidos
                if (datePart.toLowerCase().includes('m')) {
                    const temp = timeStr;
                    timeStr = datePart;
                    datePart = temp;
                }

                const dateParts = datePart.split('/');
                if (dateParts.length < 3) return null;
                const day = parseInt(dateParts[0], 10);
                const month = parseInt(dateParts[1], 10) - 1;
                let year = parseInt(dateParts[2], 10);
                if (year < 100) year += 2000;

                const timeMatch = timeStr.match(/(\d+):(\d+)\s*(a\.?\s*m\.?|p\.?\s*m\.?)/i);
                let hours = 0, mins = 0;

                if (timeMatch) {
                    hours = parseInt(timeMatch[1], 10);
                    mins = parseInt(timeMatch[2], 10);
                    const ampm = timeMatch[3].toLowerCase().replace(/[\.\s]/g, '');
                    if (ampm === 'pm' && hours < 12) hours += 12;
                    if (ampm === 'am' && hours === 12) hours = 0;
                } else {
                    // Fallback para formato 24h
                    const time24 = timeStr.match(/(\d+):(\d+)/);
                    if (time24) {
                        hours = parseInt(time24[1], 10);
                        mins = parseInt(time24[2], 10);
                    }
                }

                return new Date(year, month, day, hours, mins).getTime();
            } catch (e) {
                return null;
            }
        },

        async processNode(row) {
            try {
                const id = row.getAttribute('data-id');
                this.seenIds.add(id);

                const textContainer = row.querySelector(SELECTORS.copyableText);
                if (!textContainer) return;

                const preText = textContainer.getAttribute('data-pre-plain-text');
                const textNode = textContainer.querySelector('span.selectable-text') || textContainer;

                if (preText && textNode) {
                    const match = preText.match(/^\[(.*?)\]\s*(.*?):/);
                    const dateTime = match ? match[1].trim() : "Fecha desconocida";
                    const rawSender = match ? match[2].trim() : "Desconocido";

                    // Comprobamos el límite temporal
                    if (this.limitTimestamp && dateTime !== "Fecha desconocida") {
                        const msgTimeMs = this.parseWhatsAppDate(dateTime);
                        if (msgTimeMs && msgTimeMs > this.limitTimestamp) {
                            this.reachedLimit = true;
                            return; // Ignora este mensaje y aborta
                        }
                    }

                    // Expande Leer Más solo si estamos seguros de que vamos a copiar el mensaje
                    const readMoreBtn = Array.from(row.querySelectorAll(SELECTORS.readMoreBtn)).find(b => {
                        const text = (b.innerText || '').toLowerCase();
                        return text.includes('leer m') || text.includes('read more');
                    });

                    if (readMoreBtn) {
                        readMoreBtn.click();
                        await new Promise(r => setTimeout(r, 200));
                    }

                    let text = textNode.innerText;
                    if (!text) text = textNode.textContent;
                    text = text.trim();

                    if (text) {
                        const finalSender = this.resolveSenderName(rawSender, row);
                        this.buffer.push(`[${dateTime}] ${finalSender}: ${text}`);
                        this.updateCounter(this.buffer.length);
                    }
                }
            } catch (err) {
                console.error("[SCRAPER ERROR] Fallo al procesar nodo:", err);
            }
        },

        showPanel() {
            if (!this.panelUi) {
                this.panelUi = document.createElement('div');
                this.panelUi.style.cssText = `position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 9999999; background: rgba(32, 44, 51, 0.95); border: 2px solid #00a884; border-radius: 12px; padding: 15px 30px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); color: #d1d7db; font-family: sans-serif; font-size: 16px; backdrop-filter: blur(4px); display: flex; flex-direction: column; align-items: center; gap: 15px; width: 350px; transition: width 0.3s;`;

                this.counterUi = document.createElement('div');
                this.counterUi.style.fontWeight = 'bold';

                const stopBtn = document.createElement('button');
                stopBtn.id = 'scraper-stop-btn';
                stopBtn.innerText = '⏹️ Parar y Mostrar Texto';
                stopBtn.style.cssText = `background:#ea4335; color:white; border:none; padding: 10px 20px; border-radius: 8px; font-weight:bold; cursor:pointer; width: 100%; transition: background 0.2s; font-size: 14px;`;
                stopBtn.onclick = () => this.stopAndShowResult();

                this.panelUi.appendChild(this.counterUi);
                this.panelUi.appendChild(stopBtn);
                document.body.appendChild(this.panelUi);
            }
            this.counterUi.style.color = '#d1d7db';
            this.panelUi.style.display = 'flex';
        },

        hidePanel() {
            if (this.panelUi) this.panelUi.style.display = 'none';
        },

        updateCounter(count) {
            if (this.counterUi) {
                this.counterUi.innerText = `⏳ Copiando... ${count} mensajes extraídos`;
            }
        }
    };

    // ==========================================
    // MODAL DE CONFIGURACIÓN
    // ==========================================
    function showConfigModal(startId) {
        if (document.getElementById('scraper-config-modal')) return;

        const modalOverlay = document.createElement('div');
        modalOverlay.id = 'scraper-config-modal';
        modalOverlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.6); z-index: 9999999; display: flex; justify-content: center; align-items: center; backdrop-filter: blur(2px);`;

        const modalBox = document.createElement('div');
        modalBox.style.cssText = `background: #111b21; border: 1px solid #2a3942; border-radius: 12px; padding: 20px; width: 320px; color: #d1d7db; font-family: sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.5);`;

        const title = document.createElement('div');
        title.innerHTML = '⚙️ <b>Opciones de Extracción</b>';
        title.style.cssText = `font-size: 16px; margin-bottom: 15px; border-bottom: 1px solid #2a3942; padding-bottom: 10px;`;

        // Calcular fecha y hora por defecto (Hoy a las 09:00)
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const defaultDateTime = `${yyyy}-${mm}-${dd}T09:00`;

        const limitDiv = document.createElement('div');
        limitDiv.style.cssText = `display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px;`;

        limitDiv.innerHTML = `
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px;">
                <input type="checkbox" id="scraper-use-limit" style="cursor: pointer; width: 16px; height: 16px;">
                Detener en fecha/hora límite
            </label>
            <input type="datetime-local" id="scraper-limit-time" value="${defaultDateTime}" disabled style="padding: 8px; border-radius: 6px; border: 1px solid #2a3942; background: #202c33; color: white; color-scheme: dark; font-family: inherit;">
        `;

        const btnDiv = document.createElement('div');
        btnDiv.style.cssText = `display: flex; gap: 10px;`;

        const startBtn = document.createElement('button');
        startBtn.innerText = '▶️ Iniciar';
        startBtn.style.cssText = `flex: 1; background: #00a884; color: #111b21; border: none; padding: 10px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: opacity 0.2s;`;

        const cancelBtn = document.createElement('button');
        cancelBtn.innerText = '✖️ Cancelar';
        cancelBtn.style.cssText = `flex: 1; background: #374045; color: #d1d7db; border: none; padding: 10px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: opacity 0.2s;`;

        btnDiv.appendChild(cancelBtn);
        btnDiv.appendChild(startBtn);

        modalBox.appendChild(title);
        modalBox.appendChild(limitDiv);
        modalBox.appendChild(btnDiv);
        modalOverlay.appendChild(modalBox);
        document.body.appendChild(modalOverlay);

        // Lógica del modal
        const checkbox = document.getElementById('scraper-use-limit');
        const dateInput = document.getElementById('scraper-limit-time');

        checkbox.addEventListener('change', () => {
            dateInput.disabled = !checkbox.checked;
            dateInput.style.opacity = checkbox.checked ? '1' : '0.5';
        });

        cancelBtn.onclick = () => modalOverlay.remove();

        startBtn.onclick = () => {
            let limitTimeMs = null;
            if (checkbox.checked && dateInput.value) {
                limitTimeMs = new Date(dateInput.value).getTime();
            }
            modalOverlay.remove();
            Scraper.start(startId, limitTimeMs);
        };
    }

    function initHoverUI() {
        const hoverBtn = document.createElement('button');
        hoverBtn.id = 'scraper-hover-btn';
        hoverBtn.innerHTML = '📑';
        hoverBtn.title = "Copiar desde aquí";
        hoverBtn.style.cssText = `position: fixed; right: 100px; z-index: 9999999; display: none; background: #00a884; border: none; border-radius: 50%; width: 44px; height: 44px; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.4); font-size: 20px; text-align: center; line-height: 44px; transform: translateY(-50%); transition: transform 0.1s;`;

        hoverBtn.onmouseenter = () => hoverBtn.style.transform = 'translateY(-50%) scale(1.1)';
        hoverBtn.onmouseleave = () => hoverBtn.style.transform = 'translateY(-50%) scale(1)';

        document.body.appendChild(hoverBtn);

        document.addEventListener('mousemove', (e) => {
            if (Scraper.isScraping || document.getElementById('scraper-config-modal')) {
                hoverBtn.style.display = 'none';
                return;
            }

            const row = e.target.closest(SELECTORS.messageRow);
            if (row) {
                hoverBtn.dataset.targetId = row.getAttribute('data-id');
                const rect = row.getBoundingClientRect();
                hoverBtn.style.top = `${rect.top + (rect.height / 2)}px`;
                hoverBtn.style.display = 'block';
            } else if (e.target !== hoverBtn) {
                hoverBtn.style.display = 'none';
            }
        });

        hoverBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const startId = hoverBtn.dataset.targetId;
            if (startId) {
                hoverBtn.style.display = 'none';
                showConfigModal(startId); // Abrimos el menú intermedio
            }
        });
    }

    function init() {
        if (window.scraperEngineInitialized) return;
        window.scraperEngineInitialized = true;

        initHoverUI();
        console.log("%c[Scraper Engine] V2.0. Menú de Límite Temporal activo.", "background: #00a884; color: white; font-weight: bold; padding: 5px; font-size: 14px;");
    }

    const checkExist = setInterval(() => {
        if (document.querySelector(SELECTORS.messageRow) || document.getElementById('app')) {
            clearInterval(checkExist);
            init();
        }
    }, 1000);

})();
