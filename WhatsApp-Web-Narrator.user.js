// ==UserScript==
// @name         WhatsApp Web TTS and Audio Chronological Autoplay
// @namespace    http://tampermonkey.net/
// @version      1.0.2
// @description  Convierte WhatsApp Web en un audiolibro interactivo. Lee mensajes y audios cronológicamente, usando un Narrador inteligente para los nombres y voces únicas por participante.
// @author       Alex
// @match        https://web.whatsapp.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=whatsapp.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const SELECTORS = {
        appContainer: '#app',
        messageRow: 'div[data-id]',
        copyableText: '.copyable-text',
        audioSlider: '[role="slider"]',
        readMoreBtn: '[role="button"]'
    };

    const voiceManager = {
        assignments: new Map(),
        voices: [],
        narratorVoice: null,

        init() {
            this.updateVoices();
            if (window.speechSynthesis.onvoiceschanged !== undefined) {
                window.speechSynthesis.onvoiceschanged = () => this.updateVoices();
            }
        },

        updateVoices() {
            let allVoices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('es'));
            if (allVoices.length === 0) allVoices = window.speechSynthesis.getVoices();

            // Reservamos la primera voz para el Narrador y el resto para los participantes
            if (allVoices.length > 1) {
                this.narratorVoice = allVoices[0];
                this.voices = allVoices.slice(1);
            } else {
                this.narratorVoice = allVoices[0] || null;
                this.voices = allVoices; 
            }
        },

        getVoice(sender) {
            if (this.assignments.has(sender)) return this.assignments.get(sender);
            if (this.voices.length === 0) return null;
            const index = this.assignments.size % this.voices.length;
            const assignedVoice = this.voices[index];
            this.assignments.set(sender, assignedVoice);
            return assignedVoice;
        }
    };

    // ==========================================
    // CONTROLADOR LINEAL DEL DOM Y PANEL
    // ==========================================
    const TTSController = {
        isPlaying: false,
        isSkipping: false,
        audioTimeout: null,
        currentResolve: null,
        currentRow: null,
        nameMap: new Map(), 
        lastSenderName: null, // Memoria para no repetir el narrador

        ttsRate: 1.0,
        pauseMs: 600,

        playbackControlsUi: null,

        start(firstMessageId) {
            this.isPlaying = true;
            this.isSkipping = false;
            this.nameMap.clear(); 
            this.lastSenderName = null; 
            if (this.playbackControlsUi) this.playbackControlsUi.style.display = 'flex';
            console.log(`[TTS-DEBUG] 🚀 INICIANDO lectura encadenada desde: ${firstMessageId}`);
            this.process(firstMessageId);
        },

        stop() {
            this.isPlaying = false;
            this.isSkipping = false;
            window.speechSynthesis.cancel();
            if (this.audioTimeout) clearTimeout(this.audioTimeout);

            if (this.currentResolve) {
                this.currentResolve();
                this.currentResolve = null;
            }

            if (this.playbackControlsUi) this.playbackControlsUi.style.display = 'none';
            console.log('[TTS-DEBUG] 🛑 Lectura detenida por el usuario.');
        },

        skip() {
            console.log('[TTS-DEBUG] ⏭️ Salto solicitado. Abortando audio/voz actual...');
            this.isSkipping = true;

            if (this.currentRow) {
                const pauseBtn = Array.from(this.currentRow.querySelectorAll('button')).find(b => {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    return label.includes('paus');
                });
                if (pauseBtn) pauseBtn.click();
            }

            window.speechSynthesis.cancel();
            if (this.audioTimeout) clearTimeout(this.audioTimeout);

            if (this.currentResolve) {
                this.currentResolve();
                this.currentResolve = null;
            }
        },

        async process(id) {
            if (!this.isPlaying) return;
            this.isSkipping = false;

            const row = document.querySelector(`div[data-id="${id}"]`);
            if (!row) {
                console.warn(`[TTS-DEBUG] ❌ Mensaje ${id} desaparecido del DOM. Fin de la lectura.`);
                this.stop();
                return;
            }

            this.currentRow = row;
            row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await new Promise(r => setTimeout(r, 600));

            if (!this.isPlaying) return;

            const readMoreBtn = Array.from(row.querySelectorAll(SELECTORS.readMoreBtn)).find(b => {
                const text = (b.innerText || '').toLowerCase();
                return text.includes('leer m') || text.includes('read more');
            });

            if (readMoreBtn) {
                console.log(`[TTS-DEBUG] 📖 Desplegando "Leer más"...`);
                readMoreBtn.click();
                await new Promise(r => setTimeout(r, 400));
            }

            if (!this.isPlaying) return;

            const isAudio = row.querySelector(SELECTORS.audioSlider) || Array.from(row.querySelectorAll('button')).some(b => (b.getAttribute('aria-label')||'').toLowerCase().includes('reproduc'));
            let actionTaken = false;

            if (isAudio) {
                console.log(`[TTS-DEBUG] 🎵 Procesando Audio...`);
                // Si es audio, reiniciamos el último emisor para que el texto posterior sí lo anuncie
                this.lastSenderName = null; 
                await this.playAudio(row);
                actionTaken = true;
            } else {
                const textData = this.extractText(row);
                if (textData) {
                    if (textData.hasLink) {
                        console.log(`[TTS-DEBUG] 🔗 Enlace detectado.`);
                        await this.speak(`${textData.senderName} manda un enlace.`, voiceManager.narratorVoice);
                        this.lastSenderName = textData.senderName;
                    } else if (textData.text) {
                        
                        let narratorPhrase = "";

                        // Lógica inteligente de repetición
                        if (textData.isReply) {
                            if (textData.quotedName) {
                                if (textData.senderName === this.lastSenderName) {
                                    narratorPhrase = `Respondiendo a ${textData.quotedName}`;
                                } else {
                                    narratorPhrase = `${textData.senderName} respondiendo a ${textData.quotedName}`;
                                }
                            }
                        } else {
                            if (textData.senderName !== this.lastSenderName) {
                                narratorPhrase = textData.senderName;
                            }
                        }

                        // Actualizamos el último emisor
                        this.lastSenderName = textData.senderName;

                        if (narratorPhrase) {
                            console.log(`[TTS-DEBUG] 🗣️ Narrador anuncia: ${narratorPhrase}`);
                            await this.speak(narratorPhrase, voiceManager.narratorVoice);
                            await new Promise(r => setTimeout(r, 300)); 
                        } else {
                            console.log(`[TTS-DEBUG] 🗣️ Narrador silenciado (Mismo emisor continuo o respuesta a número).`);
                        }
                        
                        if (this.isPlaying && !this.isSkipping) {
                            console.log(`[TTS-DEBUG] 🗣️ Participante lee el mensaje...`);
                            await this.speak(textData.text, textData.participantVoice);
                        }
                    }
                    actionTaken = true;
                }
            }

            if (!this.isPlaying) return;

            if (actionTaken && !this.isSkipping) {
                await new Promise(r => setTimeout(r, this.pauseMs));
            }

            const allVisibleRows = Array.from(document.querySelectorAll(SELECTORS.messageRow));
            const currentIndex = allVisibleRows.findIndex(r => r.getAttribute('data-id') === id);

            if (currentIndex !== -1 && currentIndex + 1 < allVisibleRows.length) {
                const nextId = allVisibleRows[currentIndex + 1].getAttribute('data-id');
                console.log(`[TTS-DEBUG] ⏭️ Siguiente mensaje: ${nextId}`);
                this.process(nextId);
            } else {
                console.log(`[TTS-DEBUG] 🏁 No hay más mensajes. Fin.`);
                this.stop();
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

        extractText(row) {
            const textContainer = row.querySelector(SELECTORS.copyableText);
            if (!textContainer) return null;

            const preText = textContainer.getAttribute('data-pre-plain-text');
            
            let isReply = false;
            let quotedName = null;

            const quoteBlock = row.querySelector('[data-testid="quoted-message"]');
            if (quoteBlock) {
                isReply = true;
                const authorSpan = quoteBlock.querySelector('[data-testid="author"]') || quoteBlock.querySelector('span[dir="auto"]');
                if (authorSpan) {
                    let rawQuoteName = authorSpan.textContent.trim();
                    rawQuoteName = rawQuoteName.replace(/^~\s*/, '');
                    
                    const isNumber = /^\+?[\d\s\-]{7,}$/.test(rawQuoteName);
                    if (!isNumber && rawQuoteName.length > 0) {
                        quotedName = rawQuoteName;
                    }
                }
            }

            const clone = textContainer.cloneNode(true);
            const quoteInClone = clone.querySelector('[data-testid="quoted-message"]');
            if (quoteInClone) quoteInClone.remove();

            // Extirpamos explícitamente el metadato de la hora si quedó atrapado dentro
            const metaInClone = clone.querySelector('[data-testid="msg-meta"]');
            if (metaInClone) metaInClone.remove();

            const textNode = clone.querySelector('span.selectable-text') || clone;

            if (preText && textNode) {
                const match = preText.match(/^\[(.*?)\]\s*(.*?):/);
                const rawSender = match ? match[2].trim() : "Desconocido";
                
                const senderName = this.resolveSenderName(rawSender, row);
                const hasLink = !!row.querySelector('a'); 
                
                let text = textNode.innerText || textNode.textContent;
                text = text.trim();

                // Regex barredora: elimina cualquier hora residual suelta al final del texto (ej. "11:04 a. m.")
                text = text.replace(/\s*\d{1,2}:\d{2}\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?\s*$/i, '');

                return { 
                    text: text, 
                    senderName: senderName, 
                    participantVoice: voiceManager.getVoice(rawSender),
                    hasLink: hasLink,
                    isReply: isReply,
                    quotedName: quotedName
                };
            }
            return null;
        },

        playAudio(row) {
            return new Promise((resolve) => {
                this.currentResolve = resolve;

                let playBtn = Array.from(row.querySelectorAll('button')).find(b => {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    return label.includes('reproduc') || label.includes('play');
                });
                if (!playBtn) playBtn = row.querySelector('button');

                if (!playBtn) {
                    console.warn('[TTS-DEBUG] No se encontró botón de play. Omitiendo.');
                    this.currentResolve = null;
                    return resolve();
                }

                const slider = row.querySelector(SELECTORS.audioSlider);
                const durationSecs = slider ? parseInt(slider.getAttribute('aria-valuemax') || '5', 10) : 5;

                let playbackSpeed = 1;
                const speedBtn = Array.from(row.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes('velocidad'));
                if (speedBtn) {
                    const speedMatch = speedBtn.innerText.match(/(\d+(\.\d+)?)/);
                    if (speedMatch) playbackSpeed = parseFloat(speedMatch[1]);
                }

                const realDurationSecs = durationSecs / playbackSpeed;
                const waitTimeMs = (realDurationSecs * 1000) + 2000;

                playBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                playBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                playBtn.click();

                this.audioTimeout = setTimeout(() => {
                    this.currentResolve = null;
                    resolve();
                }, waitTimeMs);
            });
        },

        speak(text, voice) {
            return new Promise((resolve) => {
                this.currentResolve = resolve;
                const utterance = new SpeechSynthesisUtterance(text);
                if (voice) utterance.voice = voice;
                utterance.lang = voice ? voice.lang : 'es-ES';
                utterance.rate = this.ttsRate; 

                utterance.onend = () => { this.currentResolve = null; resolve(); };
                utterance.onerror = () => { this.currentResolve = null; resolve(); };
                window.speechSynthesis.speak(utterance);
            });
        }
    };

    // ==========================================
    // INTERFAZ DE USUARIO: PANEL IZQUIERDO Y HOVER
    // ==========================================
    function initControlPanel() {
        if (document.getElementById('tts-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'tts-panel';
        panel.style.cssText = `position: fixed; bottom: 20px; left: 20px; z-index: 999999; background: rgba(32, 44, 51, 0.95); border: 1px solid #2a3942; border-radius: 12px; padding: 15px; width: 240px; box-shadow: 0 4px 12px rgba(0,0,0,0.4); color: #d1d7db; font-family: sans-serif; font-size: 14px; backdrop-filter: blur(4px); transition: opacity 0.3s;`;

        panel.innerHTML = `
            <div style="font-weight:bold; margin-bottom: 12px; border-bottom: 1px solid #2a3942; padding-bottom: 8px;">⚙️ Ajustes TTS Engine</div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <span>🗣️ Vel. Voz: <span id="tts-rate-val">1.0</span>x</span>
                <div style="display: flex; gap: 5px;">
                    <button id="tts-rate-dec" style="background:#374045; border:none; color:white; padding: 2px 10px; border-radius: 4px; cursor:pointer; font-weight:bold;">-</button>
                    <button id="tts-rate-inc" style="background:#374045; border:none; color:white; padding: 2px 10px; border-radius: 4px; cursor:pointer; font-weight:bold;">+</button>
                </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                <span>⏱️ Pausa: <span id="tts-pause-val">0.6</span>s</span>
                <div style="display: flex; gap: 5px;">
                    <button id="tts-pause-dec" style="background:#374045; border:none; color:white; padding: 2px 10px; border-radius: 4px; cursor:pointer; font-weight:bold;">-</button>
                    <button id="tts-pause-inc" style="background:#374045; border:none; color:white; padding: 2px 10px; border-radius: 4px; cursor:pointer; font-weight:bold;">+</button>
                </div>
            </div>

            <div id="tts-playback-controls" style="display: none; gap: 8px; flex-direction: column; border-top: 1px solid #2a3942; padding-top: 12px;">
                <button id="tts-skip-btn" style="background:#00a884; color:#111b21; border:none; padding: 10px; border-radius: 8px; font-weight:bold; cursor:pointer; width: 100%; transition: background 0.2s;">⏭️ Saltar mensaje</button>
                <button id="tts-stop-btn" style="background:#ea4335; color:white; border:none; padding: 10px; border-radius: 8px; font-weight:bold; cursor:pointer; width: 100%; transition: background 0.2s;">🛑 Detener todo</button>
            </div>
        `;

        document.body.appendChild(panel);

        document.getElementById('tts-rate-dec').onclick = () => {
            TTSController.ttsRate = Math.max(0.5, TTSController.ttsRate - 0.25);
            document.getElementById('tts-rate-val').innerText = TTSController.ttsRate.toFixed(2);
        };
        document.getElementById('tts-rate-inc').onclick = () => {
            TTSController.ttsRate = Math.min(3.0, TTSController.ttsRate + 0.25);
            document.getElementById('tts-rate-val').innerText = TTSController.ttsRate.toFixed(2);
        };
        document.getElementById('tts-pause-dec').onclick = () => {
            TTSController.pauseMs = Math.max(0, TTSController.pauseMs - 200);
            document.getElementById('tts-pause-val').innerText = (TTSController.pauseMs / 1000).toFixed(1);
        };
        document.getElementById('tts-pause-inc').onclick = () => {
            TTSController.pauseMs = Math.min(5000, TTSController.pauseMs + 200);
            document.getElementById('tts-pause-val').innerText = (TTSController.pauseMs / 1000).toFixed(1);
        };

        document.getElementById('tts-skip-btn').onclick = () => TTSController.skip();
        document.getElementById('tts-stop-btn').onclick = () => TTSController.stop();

        TTSController.playbackControlsUi = document.getElementById('tts-playback-controls');
    }

    function initHoverUI() {
        const hoverBtn = document.createElement('button');
        hoverBtn.id = 'tts-hover-btn';
        hoverBtn.innerHTML = '▶️';
        hoverBtn.style.cssText = `position: fixed; right: 30px; z-index: 999999; display: none; background: #25D366; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; box-shadow: 0 4px 6px rgba(0,0,0,0.3); font-size: 18px; text-align: center; line-height: 40px; transform: translateY(-50%); transition: transform 0.1s;`;

        hoverBtn.onmouseenter = () => hoverBtn.style.transform = 'translateY(-50%) scale(1.1)';
        hoverBtn.onmouseleave = () => hoverBtn.style.transform = 'translateY(-50%) scale(1)';

        document.body.appendChild(hoverBtn);

        let activeRowId = null;

        document.addEventListener('mousemove', (e) => {
            if (TTSController.isPlaying) {
                hoverBtn.style.display = 'none';
                return;
            }

            const row = e.target.closest(SELECTORS.messageRow);
            if (row) {
                activeRowId = row.getAttribute('data-id');
                const rect = row.getBoundingClientRect();
                hoverBtn.style.top = `${rect.top + (rect.height / 2)}px`;
                hoverBtn.style.display = 'block';
            } else if (e.target !== hoverBtn) {
                hoverBtn.style.display = 'none';
            }
        });

        hoverBtn.addEventListener('click', () => {
            if (activeRowId) {
                hoverBtn.style.display = 'none';
                TTSController.start(activeRowId);
            }
        });
    }

    function init() {
        if (window.ttsEngineInitialized) return;
        window.ttsEngineInitialized = true;

        voiceManager.init();
        initControlPanel();
        initHoverUI();

        console.log("%c[TTS Engine] Listo v1.0.2. Narrador fluido y reloj silenciado.", "background: #25D366; color: white; font-weight: bold; padding: 3px;");
    }

    const checkExist = setInterval(() => {
        if (document.querySelector(SELECTORS.appContainer)) {
            clearInterval(checkExist);
            init();
        }
    }, 1000);

})();