// @ts-check
/**
 * PhysicalCloud-auto.js — Bloco B: Modo Conexão Automática
 *
 * Responsabilidades:
 *   - Gerar e persistir ID no formato PC- seguido de 27 caracteres
 *   - Calcular SHA-256 do ID via crypto.subtle (nunca expõe ID puro ao servidor)
 *   - Ativar/desativar o modo automático (registro no servidor via hash)
 *   - Aceitar transferências automaticamente quando origem === "auto"
 *   - Expor PhysicalCloudAuto para uso pelo index.html
 *
 * DEPENDÊNCIAS (devem estar carregados antes deste script):
 *   - PhysicalCloud.js  (window.PhysicalCloud.enviar, window.PhysicalCloud.socket)
 *   - android-bridge.js (opcional — para manter serviço em alta prioridade)
 *
 * EVENTOS EMITIDOS:
 *   physicalcloud:auto-ativado    — { idLocal, idHash }
 *   physicalcloud:auto-desativado — {}
 *   physicalcloud:auto-erro       — { motivo }
 *
 * EVENTOS ESCUTADOS (de PhysicalCloud.js via window):
 *   physicalcloud:mensagem-recebida — para detectar pedido-automatico
 *
 * LOCALSTORAGE:
 *   physicalCloudAutoId             — ID local em texto puro
 *   physicalCloudAutoIdHash         — hash SHA-256 usado apenas para revogação local
 *   physicalCloudModoAuto           — "ativo" | "inativo"
 *   physicalCloudAutoNome   — nome salvo para exibição (cópia de physicalCloudNomeDispositivo)
 */

(function () {
    "use strict";

    // ─── Constantes ──────────────────────────────────────────────────────────
    const KEY_AUTO_ID    = "physicalCloudAutoId";
    // Chave legada usada apenas para migrar instalações que armazenavam o ID em formato cifrado legado.
    const KEY_AUTO_ID_PROTEGIDO_LEGADO = "physicalCloudAutoIdEncryptedV1";
    const KEY_AUTO_CONFIGURACAO_LEGADA_MIGRADA = "physicalCloudAutoLegacyIdMigratedV1";
    const KEY_AUTO_ID_HASH = "physicalCloudAutoIdHash";
    const KEY_AUTO_MODO  = "physicalCloudModoAuto";
    const KEY_AUTO_INICIALIZACAO_LIMPA = "physicalCloudAutoFreshStartV1";
    let inicializacaoLimpaPromise = Promise.resolve(true);
    const KEY_AUTO_PASTA = "physicalCloudAutoPastaUri";   // pasta de destino do modo auto
    const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I/O/0/1 (confusão visual)
    const ID_LEN  = 27; // aproximadamente 135 bits de entropia
    const KEY_AUTO_ID_LEGACY = "physicalCloudAutoIdLegacyToRevoke";
    const KEY_AUTO_REVOGACOES_PENDENTES = "physicalCloudAutoRevocationsPending";
    const TEMPO_LIMITE_REVOGACAO_MS = 5000;
    const TEMPO_LIMITE_REGISTRO_MS = 12000;
    const desregistrosEmAndamento = new Map();
    const registrosEmAndamento = new Map();
    let processandoRevogacoes = false;
    let ativacaoEmAndamento = null;
    let reRegistroEmAndamento = false;
    let reRegistroPendente = false;
    let reRegistroAgendado = false;
    let versaoEstadoAuto = 0;

    // ─── Utilitários ─────────────────────────────────────────────────────────

    /** Lê localStorage com fallback silencioso (modo privado). */
    function lsGet(key) {
        try { return localStorage.getItem(key); } catch { return null; }
    }

    /** Grava localStorage com fallback silencioso. */
    function lsSet(key, val) {
        try { localStorage.setItem(key, val); } catch { /* noop */ }
    }

    /** Remove chave do localStorage. */
    function lsRemove(key) {
        try { localStorage.removeItem(key); } catch { /* noop */ }
    }

    // Hashes de ID são credenciais para o protocolo de conexão automática.
    // No Android, são guardados cifrados por uma chave não exportável do Keystore.
    // Na Web/Desktop, mantém-se o armazenamento já usado por essas plataformas.
    const CHAVES_SENSIVEIS = new Set([KEY_AUTO_ID_HASH, KEY_AUTO_REVOGACOES_PENDENTES, KEY_AUTO_ID_LEGACY]);
    function dadoSensivelGet(key) {
        if (!CHAVES_SENSIVEIS.has(key)) return lsGet(key);
        try {
            if (window.AndroidBridge && typeof AndroidBridge.secureStoreGet === "function") {
                const value = AndroidBridge.secureStoreGet(key);
                if (value !== null && value !== undefined) return value;
                // Migra valores criados por versões anteriores para o Keystore.
                const legado = lsGet(key);
                if (legado !== null) {
                    if (!AndroidBridge.secureStoreSet(key, legado)) throw new Error("Falha ao migrar credencial local para o Android Keystore.");
                    lsRemove(key);
                    return legado;
                }
                return null;
            }
        } catch (e) {
            console.error("[AutoMode] Falha ao ler armazenamento seguro:", e);
            return null;
        }
        return lsGet(key);
    }
    function dadoSensivelSet(key, value) {
        if (!CHAVES_SENSIVEIS.has(key)) { lsSet(key, value); return lsGet(key) === String(value); }
        try {
            if (window.AndroidBridge && typeof AndroidBridge.secureStoreSet === "function") {
                const ok = AndroidBridge.secureStoreSet(key, String(value));
                if (ok) lsRemove(key);
                return !!ok;
            }
            lsSet(key, value);
            return lsGet(key) === String(value);
        } catch (e) {
            console.error("[AutoMode] Falha ao gravar armazenamento seguro:", e);
            return false;
        }
    }
    function dadoSensivelRemove(key) {
        if (!CHAVES_SENSIVEIS.has(key)) { lsRemove(key); return; }
        try { if (window.AndroidBridge && typeof AndroidBridge.secureStoreRemove === "function") AndroidBridge.secureStoreRemove(key); } catch {}
        lsRemove(key);
    }
    function sincronizarModoNativo(ativo) {
        try { if (window.AndroidBridge && typeof AndroidBridge.setAutoModeActive === "function") AndroidBridge.setAutoModeActive(!!ativo); } catch (e) { console.warn("[AutoMode] Não foi possível sincronizar o serviço Android:", e); }
    }

    /** Emite CustomEvent em window. */
    function emitir(tipo, detalhe) {
        window.dispatchEvent(new CustomEvent(tipo, { detail: detalhe || {} }));
    }

    // ─── Geração e obtenção do ID ─────────────────────────────────────────────

    /**
     * Gera um novo ID no formato PC- seguido de 27 caracteres usando crypto.getRandomValues.
     * @returns {string}
     */
    function gerarNovoId() {
        const chars = [];
        // Rejeição de bytes fora do múltiplo do alfabeto evita viés de módulo.
        while (chars.length < ID_LEN) {
            const bytes = new Uint8Array(32);
            crypto.getRandomValues(bytes);
            for (const b of bytes) {
                if (b < Math.floor(256 / CHARSET.length) * CHARSET.length) {
                    chars.push(CHARSET[b % CHARSET.length]);
                    if (chars.length === ID_LEN) break;
                }
            }
        }
        return "PC-" + chars.join("");
    }

    /**
     * Retorna o ID atual do modo automático.
     * Se não existir, gera e persiste um novo.
     * @returns {string}
     */
    function obterOuGerarId() {
        let id = lsGet(KEY_AUTO_ID);
        if (!id || !/^PC-[A-Z0-9]{27}$/.test(id)) {
            if (id && /^PC-[A-Z0-9]{8}$/.test(id)) {
                dadoSensivelSet(KEY_AUTO_ID_LEGACY, id);
                try { window.PhysicalCloud?.aviso?.("Seu ID automático foi atualizado para um código mais seguro. Compartilhe o novo ID."); } catch {}
            }
            id = gerarNovoId();
            lsSet(KEY_AUTO_ID, id);
        }
        return id;
    }

    /**
     * Força a geração de um novo ID, invalidando o anterior.
     * @returns {string}
     */
    function gerarNovoIdForçado() {
        // Invalida ativação/re-registro em andamento para que um ACK atrasado
        // não volte a registrar o identificador anterior.
        versaoEstadoAuto++;
        const anterior = lsGet(KEY_AUTO_ID);
        if (anterior) dadoSensivelSet(KEY_AUTO_ID_LEGACY, anterior);
        const id = gerarNovoId();
        lsSet(KEY_AUTO_ID, id);
        return id;
    }

    // ─── Hash SHA-256 ──────────────────────────────────────────────────────────

    /**
     * Calcula SHA-256 de uma string usando WebCrypto.
     * @param {string} texto
     * @returns {Promise<string>} hex lowercase
     */
    async function sha256Hex(texto) {
        const encoder = new TextEncoder();
        const data    = encoder.encode(texto);
        const hashBuf = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, "0"))
            .join("");
    }

    // ─── Estado do modo automático ────────────────────────────────────────────

    // O modo automático sempre inicia desligado nesta primeira inicialização.
    // Não oferecemos reativar um ID antigo de testes/versões anteriores.
    // O ID/hash antigo é tratado por uma migração local única, descrita abaixo.
    function modoEstaAtivo() {
        // Nunca considera uma flag antiga como ativa antes de concluir a limpeza inicial.
        return lsGet(KEY_AUTO_INICIALIZACAO_LIMPA) === "1" && lsGet(KEY_AUTO_MODO) === "ativo";
    }

    /** Retorna o ID atual somente quando o modo está ativo. */
    function obterIdAtual() {
        if (!modoEstaAtivo()) return null;
        const id = lsGet(KEY_AUTO_ID);
        return id && /^PC-[A-Z0-9]{27}$/.test(id) ? id : null;
    }

    // Migração automática dos códigos antigos de 8 caracteres para 27 caracteres.
    if (modoEstaAtivo()) {
        const idSalvo = lsGet(KEY_AUTO_ID);
        if (idSalvo && /^PC-[A-Z0-9]{8}$/.test(idSalvo)) {
            dadoSensivelSet(KEY_AUTO_ID_LEGACY, idSalvo);
            lsSet(KEY_AUTO_ID, gerarNovoId());
            try { window.PhysicalCloud?.aviso?.("Seu ID automático foi atualizado para um código mais seguro. Compartilhe o novo ID."); } catch {}
        }
    }

    // ─── Comunicação com o servidor ───────────────────────────────────────────

    /**
     * Envia mensagem via WebSocket do PhysicalCloud.js.
     * @param {object} msg
     */
    function enviarAoServidor(msg) {
        const PC = window.PhysicalCloud;
        if (PC && typeof PC.enviar === "function") {
            return PC.enviar(msg) === true;
        }
        if (window.socket && window.socket.readyState === WebSocket.OPEN) {
            try { window.socket.send(JSON.stringify(msg)); return true; } catch {}
        }
        console.warn("[AutoMode] WebSocket não disponível para enviar:", msg.type);
        return false;
    }

    function obterRevogacoesPendentes() {
        try {
            const valor = JSON.parse(dadoSensivelGet(KEY_AUTO_REVOGACOES_PENDENTES) || "[]");
            return Array.isArray(valor) ? [...new Set(valor.filter(x => typeof x === "string" && /^[0-9a-f]{64}$/.test(x)))] : [];
        } catch { return []; }
    }

    function salvarRevogacoesPendentes(hashes) {
        const valor = JSON.stringify([...new Set(hashes.filter(x => /^[0-9a-f]{64}$/.test(x)))]);
        try {
            return dadoSensivelSet(KEY_AUTO_REVOGACOES_PENDENTES, valor);
        } catch { return false; }
    }

    function adicionarRevogacaoPendente(idHash) {
        const hashes = obterRevogacoesPendentes();
        if (!hashes.includes(idHash)) hashes.push(idHash);
        return salvarRevogacoesPendentes(hashes);
    }

    function removerRevogacaoPendente(idHash) {
        return salvarRevogacoesPendentes(obterRevogacoesPendentes().filter(x => x !== idHash));
    }

    function gerarRequestId() {
        const bytes = new Uint8Array(18);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    }

    async function enfileirarIdLegadoSeHouver() {
        const antigo = dadoSensivelGet(KEY_AUTO_ID_LEGACY);
        if (!antigo) return true;
        const hashAntigo = await sha256Hex(antigo);
        if (!adicionarRevogacaoPendente(hashAntigo)) return false;
        dadoSensivelRemove(KEY_AUTO_ID_LEGACY); // mantém somente o hash pendente no armazenamento local
        return true;
    }

    function revogarHashComConfirmacao(idHash) {
        const PC = window.PhysicalCloud;
        if (!PC?.isAuthenticated?.()) return Promise.resolve(false);
        const requestId = gerarRequestId();
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                desregistrosEmAndamento.delete(requestId);
                resolve(false);
            }, TEMPO_LIMITE_REVOGACAO_MS);
            desregistrosEmAndamento.set(requestId, {
                idHash,
                finalizar(ok) {
                    clearTimeout(timer);
                    desregistrosEmAndamento.delete(requestId);
                    resolve(ok);
                }
            });
            const enviado = enviarAoServidor({ type: "desregistrar-id-automatico", idHash, requestId });
            if (!enviado) desregistrosEmAndamento.get(requestId)?.finalizar(false);
        });
    }

    async function processarRevogacoesPendentes() {
        if (processandoRevogacoes) return false;
        if (!window.PhysicalCloud?.isAuthenticated?.()) return obterRevogacoesPendentes().length === 0;
        processandoRevogacoes = true;
        let tudoRevogado = true;
        try {
            for (const idHash of obterRevogacoesPendentes()) {
                let confirmado = false;
                // Repetir uma vez cobre perda de ACK ou falha transitória; a operação do servidor é idempotente.
                for (let tentativa = 0; tentativa < 2; tentativa++) {
                    confirmado = await revogarHashComConfirmacao(idHash);
                    if (confirmado) break;
                    if (tentativa === 0 && window.PhysicalCloud?.isAuthenticated?.()) {
                        await new Promise(resolve => setTimeout(resolve, 350));
                    }
                }
                if (!confirmado || !removerRevogacaoPendente(idHash)) {
                    tudoRevogado = false;
                    break;
                }
            }
        } finally {
            processandoRevogacoes = false;
        }
        return tudoRevogado && obterRevogacoesPendentes().length === 0;
    }

    async function aguardarConexaoAutenticada(limiteMs = 120000) {
        const PC = window.PhysicalCloud;
        const autenticado = () => typeof PC?.isAuthenticated === "function" ? PC.isAuthenticated() : false;
        if (autenticado()) return true;
        emitir("physicalcloud:auto-status", { mensagem: "Aguardando o servidor iniciar e autenticar a conexão…" });
        const conectado = await new Promise(resolve => {
            let finalizado = false;
            const terminar = ok => {
                if (finalizado) return;
                finalizado = true;
                clearTimeout(timer);
                window.removeEventListener("physicalcloud:websocket-aberto", verificar);
                resolve(ok);
            };
            const verificar = () => { if (autenticado()) terminar(true); };
            window.addEventListener("physicalcloud:websocket-aberto", verificar);
            const timer = setTimeout(() => terminar(autenticado()), limiteMs);
            setTimeout(verificar, 0);
        });
        emitir("physicalcloud:auto-status", { mensagem: conectado ? "Servidor conectado. Finalizando a ativação…" : "Não foi possível conectar ao servidor. Verifique sua internet e tente novamente.", erro: !conectado });
        return conectado;
    }

    function registrarHashComConfirmacao(idHash, deviceId, nomeAtual) {
        if (!(window.PhysicalCloud?.isAuthenticated?.() || false)) {
            return Promise.resolve({ ok: false, timeout: false, motivo: "A conexão com o servidor ainda não foi autenticada." });
        }
        const requestId = gerarRequestId();
        return new Promise(resolve => {
            const finalizar = resultado => {
                const atual = registrosEmAndamento.get(requestId);
                if (!atual) return;
                clearTimeout(atual.timer);
                registrosEmAndamento.delete(requestId);
                resolve(resultado);
            };
            const timer = setTimeout(() => finalizar({
                ok: false, timeout: true,
                motivo: "O servidor não confirmou o registro do ID automático. Verifique a conexão e tente novamente."
            }), TEMPO_LIMITE_REGISTRO_MS);
            registrosEmAndamento.set(requestId, { idHash, timer, finalizar });
            const enviado = enviarAoServidor({
                type: "registrar-id-automatico", idHash, deviceId, nomeAtual, requestId
            });
            if (!enviado) finalizar({
                ok: false, timeout: false,
                motivo: "Não foi possível enviar o registro ao servidor. Verifique a conexão."
            });
        });
    }

    // ─── Ativação ─────────────────────────────────────────────────────────────

    /**
     * Ativa o modo conexão automática.
     * - Obtém (ou gera) o ID local
     * - Calcula hash e registra no servidor
     * - Persiste estado no localStorage
     * @returns {Promise<{ok: boolean, id: string, idHash: string}>}
     */
    async function ativar() {
        if (ativacaoEmAndamento) return ativacaoEmAndamento;
        const tarefa = (async () => {
            const versaoDaTentativa = ++versaoEstadoAuto;
            try {
                const estadoInicializado = await inicializacaoLimpaPromise;
                if (!estadoInicializado || lsGet(KEY_AUTO_INICIALIZACAO_LIMPA) !== "1") {
                    throw new Error("Não foi possível preparar o Physical Cloud com um ID novo. Feche e abra o aplicativo novamente.");
                }
                const idLocal = obterOuGerarId();
                if (!await aguardarConexaoAutenticada(120000)) {
                    throw new Error("O servidor não respondeu em até 2 minutos. Verifique sua internet e tente novamente.");
                }
                if (!await enfileirarIdLegadoSeHouver()) throw new Error("Não foi possível guardar a revogação pendente do ID antigo.");
                if (obterRevogacoesPendentes().length && !await processarRevogacoesPendentes()) {
                    throw new Error("Não foi possível concluir a revogação do ID anterior. Tente novamente quando a conexão estiver estável.");
                }
                const idHash  = await sha256Hex(idLocal);
                // Persiste apenas o hash (não reversível na prática para este ID aleatório)
                // antes do envio, permitindo revogar mesmo se o processo fechar após o ACK.
                if (!dadoSensivelSet(KEY_AUTO_ID_HASH, idHash)) throw new Error("Não foi possível proteger a credencial de conexão automática neste aparelho.");
                const nomeAtual = lsGet("physicalCloudNomeDispositivo") || "Dispositivo";
                const deviceId  = obterDeviceId();

                const registro = await registrarHashComConfirmacao(idHash, deviceId, nomeAtual);
                if (!registro.ok) {
                    // Timeout é ambíguo: o banco pode ter concluído e apenas o ACK
                    // se perdido. Enfileira revogação para evitar um ID órfão ativo.
                    if (registro.timeout) {
                        if (!adicionarRevogacaoPendente(idHash)) {
                            throw new Error(registro.motivo + " Não foi possível persistir a revogação de segurança.");
                        }
                        await processarRevogacoesPendentes();
                    }
                    throw new Error(registro.motivo || "O servidor recusou o registro do ID automático.");
                }

                // Uma desativação/rotação pode ter ocorrido enquanto aguardávamos
                // o Supabase. Nunca deixa um ACK atrasado reativar o modo local.
                if (versaoDaTentativa !== versaoEstadoAuto || obterOuGerarId() !== idLocal) {
                    if (!adicionarRevogacaoPendente(idHash)) {
                        throw new Error("A ativação foi cancelada, mas não foi possível guardar a revogação pendente.");
                    }
                    await processarRevogacoesPendentes();
                    return { ok: false, id: "", idHash: "", motivo: "A ativação foi cancelada antes da confirmação." };
                }

                // Só marca como ativo e informa sucesso depois do ACK correlacionado
                // que o servidor envia após o Supabase confirmar o registro.
                lsSet(KEY_AUTO_MODO, "ativo");
                sincronizarModoNativo(true);
                console.log("[AutoMode] Ativado após confirmação do servidor.");
                emitir("physicalcloud:auto-status", { mensagem: "Conexão automática ativada e confirmada pelo servidor.", sucesso: true });
                emitir("physicalcloud:auto-ativado", { idLocal, idHash });
                return { ok: true, id: idLocal, idHash };
            } catch (err) {
                console.error("[AutoMode] Erro ao ativar:", err);
                emitir("physicalcloud:auto-status", { mensagem: err.message, erro: true });
                emitir("physicalcloud:auto-erro", { motivo: err.message });
                return { ok: false, id: "", idHash: "", motivo: err.message };
            }
        })();
        ativacaoEmAndamento = tarefa;
        try { return await tarefa; }
        finally { if (ativacaoEmAndamento === tarefa) ativacaoEmAndamento = null; }
    }

    // ─── Desativação ──────────────────────────────────────────────────────────

    /**
     * Desativa o modo conexão automática e invalida o ID atual.
     * @returns {Promise<{ok: boolean}>}
     */
    async function desativar() {
        versaoEstadoAuto++;
        try {
            const hashesParaRevogar = [];
            const hashSalvo = dadoSensivelGet(KEY_AUTO_ID_HASH);
            if (hashSalvo && /^[0-9a-f]{64}$/.test(hashSalvo)) hashesParaRevogar.push(hashSalvo);
            else {
                const idLocal = lsGet(KEY_AUTO_ID);
                if (idLocal && /^PC-[A-Z0-9]{27}$/.test(idLocal)) hashesParaRevogar.push(await sha256Hex(idLocal));
            }
            const idLegado = dadoSensivelGet(KEY_AUTO_ID_LEGACY);
            if (idLegado) hashesParaRevogar.push(await sha256Hex(idLegado));

            for (const idHash of hashesParaRevogar) {
                if (!adicionarRevogacaoPendente(idHash)) {
                    throw new Error("Não foi possível guardar a revogação pendente do ID automático.");
                }
            }

            // Desativa localmente já; conserva só hashes pendentes caso o aparelho esteja offline.
            lsRemove(KEY_AUTO_ID);
            lsRemove(KEY_AUTO_ID_PROTEGIDO_LEGADO);
            dadoSensivelRemove(KEY_AUTO_ID_HASH);
            dadoSensivelRemove(KEY_AUTO_ID_LEGACY);
            lsSet(KEY_AUTO_MODO, "inativo");
            sincronizarModoNativo(false);

            const revogado = await processarRevogacoesPendentes();
            const pendentes = obterRevogacoesPendentes().length;
            if (!revogado && pendentes) {
                const mensagem = "Modo automático desativado neste dispositivo. A revogação do código no servidor ficou pendente e será tentada ao reconectar.";
                emitir("physicalcloud:auto-revogacao-pendente", { quantidade: pendentes });
                emitir("physicalcloud:aviso", { mensagem });
            } else {
                console.log("[AutoMode] Desativado e revogação confirmada pelo servidor.");
            }
            emitir("physicalcloud:auto-desativado", { revogacaoPendente: pendentes > 0 });
            return { ok: true, revogacaoPendente: pendentes > 0 };
        } catch (err) {
            console.error("[AutoMode] Erro ao desativar:", err);
            emitir("physicalcloud:auto-erro", { motivo: err.message });
            return { ok: false, motivo: err.message };
        }
    }

    // ─── Inicialização limpa, uma única vez ──────────────────────────────────
    // O armazenamento local é próprio de cada instalação/perfil. Em perfis usados
    // durante desenvolvimento, pode haver um ID de teste antigo. Desativamos e
    // enfileiramos sua revogação sem perguntar se deve ser reativado. O novo ID só
    // será gerado quando o usuário ativar explicitamente o modo automático.
    const possuiIdProtegidoLegado = lsGet(KEY_AUTO_ID_PROTEGIDO_LEGADO) !== null;
    const precisaMigrarIdProtegidoLegado = possuiIdProtegidoLegado;
    if (precisaMigrarIdProtegidoLegado || lsGet(KEY_AUTO_INICIALIZACAO_LIMPA) !== "1") {
        // Desliga sincronamente para impedir qualquer re-registro durante a limpeza/migração.
        lsSet(KEY_AUTO_MODO, "inativo");
        inicializacaoLimpaPromise = (async () => {
            const resultado = await desativar();
            if (!resultado || !resultado.ok) {
                console.error("[AutoMode] Não foi possível concluir a limpeza/migração:", resultado?.motivo || "erro desconhecido");
                return false;
            }
            lsRemove(KEY_AUTO_ID_PROTEGIDO_LEGADO);
            if (precisaMigrarIdProtegidoLegado) {
                lsSet(KEY_AUTO_CONFIGURACAO_LEGADA_MIGRADA, "1");
                lsSet("physicalCloudAutoConfiguracaoLegadaAviso", "1");
                emitir("physicalcloud:auto-configuracao-legada-removida", {});
            }
            lsSet(KEY_AUTO_INICIALIZACAO_LIMPA, "1");
            sincronizarModoNativo(false);
            return lsGet(KEY_AUTO_INICIALIZACAO_LIMPA) === "1";
        })().catch(err => {
            console.error("[AutoMode] Falha na limpeza/migração:", err);
            return false;
        });
    }

    // ─── Re-registro ao reconectar ao servidor ────────────────────────────────
    // Quando a WebSocket reconecta, re-registra automaticamente se o modo estiver ativo.

    async function registrarIdAutomaticoAoConectar() {
        if (reRegistroEmAndamento) {
            // Não descarta um evento de reconexão que chegou durante um ACK pendente.
            reRegistroPendente = true;
            return;
        }
        reRegistroEmAndamento = true;
        // A limpeza inicial precisa terminar antes de processar qualquer re-registro.
        const inicializacaoOk = await inicializacaoLimpaPromise;
        if (!inicializacaoOk || lsGet(KEY_AUTO_INICIALIZACAO_LIMPA) !== "1") {
            reRegistroEmAndamento = false;
            reRegistroPendente = false;
            return;
        }
        sincronizarModoNativo(modoEstaAtivo());
        // Uma rotação/desativação durante qualquer await invalida esta tentativa.
        const versaoDaTentativa = versaoEstadoAuto;
        try {
            if (!await enfileirarIdLegadoSeHouver()) {
                console.warn("[AutoMode] Não foi possível guardar a revogação de um ID legado.");
                return;
            }
            if (obterRevogacoesPendentes().length && !await processarRevogacoesPendentes()) {
                console.warn("[AutoMode] Revogações antigas continuam pendentes; o novo ID não será registrado ainda.");
                return;
            }
            if (versaoDaTentativa !== versaoEstadoAuto || !modoEstaAtivo()) return;
            const idLocal = obterIdAtual();
            if (!idLocal) return;
            const idHash = await sha256Hex(idLocal);
            if (!idHash || !/^[0-9a-f]{64}$/.test(idHash)) return;
            // Não envia um código antigo se o usuário o rotacionou/desativou durante o cálculo.
            if (versaoDaTentativa !== versaoEstadoAuto || !modoEstaAtivo() ||
                (idLocal && obterIdAtual() !== idLocal)) return;

            const nomeAtual = lsGet("physicalCloudNomeDispositivo") || "Dispositivo";
            const deviceId = obterDeviceId();
            const resultado = await registrarHashComConfirmacao(idHash, deviceId, nomeAtual);
            if (!resultado.ok) {
                const mensagem = "O modo automático está habilitado localmente, mas o servidor ainda não confirmou o registro. " +
                    (resultado.motivo || "Verifique a conexão.");
                console.warn("[AutoMode] Re-registro não confirmado:", mensagem);
                try { window.PhysicalCloud?.aviso?.(mensagem); } catch {}
                emitir("physicalcloud:auto-erro", { motivo: mensagem });
                return;
            }

            // Se o usuário desativou/rotacionou enquanto o servidor processava,
            // desfazemos o registro recém-confirmado em vez de ressuscitar o ID antigo.
            if (versaoDaTentativa !== versaoEstadoAuto || !modoEstaAtivo() ||
                (idLocal && obterIdAtual() !== idLocal)) {
                if (!adicionarRevogacaoPendente(idHash)) {
                    const mensagem = "O ID antigo foi registrado durante uma alteração local, mas não foi possível guardar sua revogação. Revise a conexão automática.";
                    console.error("[AutoMode]", mensagem);
                    try { window.PhysicalCloud?.aviso?.(mensagem); } catch {}
                    emitir("physicalcloud:auto-erro", { motivo: mensagem });
                    return;
                }
                // A operação de registro foi enviada antes da revogação; o servidor
                // serializa ambas por dispositivo, então a revogação posterior prevalece.
                await processarRevogacoesPendentes();
                return;
            }
            if (!dadoSensivelSet(KEY_AUTO_ID_HASH, idHash)) throw new Error("Não foi possível proteger a credencial de conexão automática neste aparelho.");
            console.log("[AutoMode] Re-registro confirmado pelo servidor após conexão/reconexão.");
        } catch (err) {
            console.warn("[AutoMode] Falha no re-registro:", err);
        } finally {
            reRegistroEmAndamento = false;
            if (reRegistroPendente && !reRegistroAgendado && modoEstaAtivo() && window.PhysicalCloud?.isSocketOpen?.()) {
                reRegistroPendente = false;
                reRegistroAgendado = true;
                setTimeout(() => {
                    reRegistroAgendado = false;
                    if (modoEstaAtivo() && window.PhysicalCloud?.isSocketOpen?.()) registrarIdAutomaticoAoConectar();
                }, 750);
            } else if (!modoEstaAtivo()) {
                reRegistroPendente = false;
            }
        }
    }

    window.addEventListener("physicalcloud:websocket-aberto", registrarIdAutomaticoAoConectar);
    if (window.PhysicalCloud?.isSocketOpen?.()) registrarIdAutomaticoAoConectar();

    // ─── Aceite automático de transferências ─────────────────────────────────
    // Quando uma oferta chega com origem === "auto", aceita sem mostrar modal.

    window.addEventListener("physicalcloud:mensagem-recebida", function (ev) {
        const msg = ev.detail;
        if (!msg || typeof msg.type !== "string") return;

        if (msg.requestId && desregistrosEmAndamento.has(msg.requestId)) {
            const pendente = desregistrosEmAndamento.get(msg.requestId);
            if (msg.type === "desregistrar-id-automatico-ok" && msg.idHash === pendente.idHash) {
                pendente.finalizar(true);
            } else if (msg.type === "erro") {
                pendente.finalizar(false);
            }
        }

        if (msg.requestId && registrosEmAndamento.has(msg.requestId)) {
            const pendente = registrosEmAndamento.get(msg.requestId);
            if (msg.type === "registrar-id-automatico-ok" && msg.idHash === pendente.idHash) {
                pendente.finalizar({ ok: true, timeout: false });
            } else if (msg.type === "erro") {
                pendente.finalizar({
                    ok: false, timeout: false,
                    motivo: msg.mensagem || msg.error || "O servidor recusou o registro do ID automático."
                });
            }
        }

        if (msg.type === "pedido-automatico" && modoEstaAtivo()) {
            // Roteia para o handler de aceitação automática do transfer.js
            agendarAceiteAutomatico(msg);
        }
    });

    /**
     * Aceita automaticamente uma conexão recebida via modo automático.
     * Envia responder-pedido ao servidor para aprovar a sessão entrante.
     * @param {any} msg  — mensagem pedido-automatico do servidor (contém sessaoId)
     */
    function agendarAceiteAutomatico(msg) {
        setTimeout(() => {
            try {
                const sessaoId = String(msg.sessaoId || "");
                if (!sessaoId) {
                    console.warn("[AutoMode] pedido-automatico sem sessaoId:", msg);
                    return;
                }
                // Responde ao servidor aprovando a sessão
                enviarAoServidor({
                    type:      "responder-pedido",
                    sessaoId,
                    aceitar:   true,
                    permissao: "leitura-escrita"
                });
                console.log("[AutoMode] Aceite automático enviado para sessão:", sessaoId);
            } catch (err) {
                console.error("[AutoMode] Erro no aceite automático:", err);
            }
        }, 300);
    }

    // ─── Pasta de destino do modo automático ─────────────────────────────────

    /**
     * Define a pasta SAF padrão para recebimentos automáticos.
     * @param {string|null} folderUri
     */
    function definirPastaDestino(folderUri) {
        if (folderUri) {
            lsSet(KEY_AUTO_PASTA, folderUri);
        } else {
            lsRemove(KEY_AUTO_PASTA);
        }
    }

    function obterPastaDestino() {
        return lsGet(KEY_AUTO_PASTA);
    }

    // ─── Referência à função obterDeviceId de PhysicalCloud.js ───────────────
    // Fallback caso o módulo principal não a exporte.
    function obterDeviceId() {
        if (window.PhysicalCloud && typeof window.PhysicalCloud.obterDeviceId === "function") {
            return window.PhysicalCloud.obterDeviceId();
        }
        // fallback: lê direto do localStorage (mesma chave usada em PhysicalCloud.js)
        let id = lsGet("physicalCloudDeviceId");
        if (!id) {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            id = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
            lsSet("physicalCloudDeviceId", id);
        }
        return id;
    }

    // ─── API pública ──────────────────────────────────────────────────────────

    window.PhysicalCloudAuto = {
        /** Ativa o modo automático. Retorna Promise<{ok, id, idHash}>. */
        ativar,

        /** Desativa o modo e invalida o ID. Retorna Promise<{ok}>. */
        desativar,

        /** Verifica se o modo está ativo (síncrono, lê localStorage). */
        modoEstaAtivo,

        /**
         * Retorna o ID atual (texto puro) ou null se não estiver ativado.
         * Só existe no dispositivo dono — NUNCA enviar para o servidor.
         * @returns {string|null}
         */
        obterIdAtual() {
            return obterIdAtual();
        },
        reRegistrar: registrarIdAutomaticoAoConectar,

        /** Gera um novo ID, invalidando o anterior. Deve desativar e reativar depois. */
        gerarNovoId: gerarNovoIdForçado,

        /** Define pasta SAF de destino para recebimentos automáticos. */
        definirPastaDestino,

        /** Retorna URI da pasta de destino ou null. */
        obterPastaDestino
    };

    console.log("[AutoMode] PhysicalCloud-auto.js carregado. Modo ativo:", modoEstaAtivo());
})();
