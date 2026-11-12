// @ts-check
// ═══════════════════════════════════════════════════════════════════════════
// PhysicalCloud-transfer.js — FASE 1 (correções críticas)
// #1 #4 #10 #11 #15 + fallback Android para blob
// ═══════════════════════════════════════════════════════════════════════════

const TAMANHO_CHUNK = 256 * 1024;
const BUFFER_ALTO = 4 * 1024 * 1024;
const BUFFER_BAIXO = 512 * 1024;
const TIMEOUT_ACEITE_MS = 120000;
const TIMEOUT_OK_MS = 60000;
const TIMEOUT_OPERACAO_MS = 120000;
const TAMANHO_PAGINA = 100;
const TAMANHO_LOTE = 100;

if (!(/** @type {any} */ (window).PhysicalCloud)) {
    console.error("PhysicalCloud-transfer.js: window.PhysicalCloud não encontrado.");
}

class TransferError extends Error {
    /** @param {string} message @param {string} tipo @param {string} [motivo] */
    constructor(message, tipo, motivo) {
        super(message);
        this.name = "TransferError";
        this.tipo = tipo;
        this.motivo = motivo || message;
    }
}

/** @type {Map<string, RTCDataChannel>} */ const canais = new Map();
const peersSuportamChunkHash = new Set();
const peersSuportamTamanhoDesconhecido = new Set();
const LIMITE_FALLBACK_RAM = 128 * 1024 * 1024;
const LIMITE_ARQUIVO_TAMANHO_DESCONHECIDO = 1024 * 1024 * 1024 * 1024; // 1 TiB
/** @type {Map<string, any>} */ const transferencias = new Map();
/** @type {Map<string, Array<{ file: File, operacaoId: string, caminhoRelativo: string }>>} */ const filas = new Map();
/** @type {Map<string, string>} */ const ativasEnvio = new Map();
/** @type {Map<string, string>} */ const ativasRecebimento = new Map();
/** @type {Map<string, { fila: Array<() => Promise<void>>, ocupado: boolean, cancelado: boolean }>} */ const controladoresFila = new Map();

/** @type {Map<string, any>} */ const operacoes = new Map();
/** @type {Map<string, any>} */ const ofertasOperacoes = new Map();
/** @type {Map<string, any>} */ const ofertasPendentes = new Map();
/** @type {Map<string, any>} */ const recebimentos = new Map();
/** @type {Map<string, FileSystemDirectoryHandle>} */ const pastasCompartilhadas = new Map();

const aguardandoAceitacaoMap = new Map();
const aguardandoOperacaoMap = new Map();
const timeoutsOk = new Map();


// Reserva nomes na sessão atual para impedir que duas transferências concorrentes
// do próprio app escolham o mesmo destino. A API do navegador não oferece criação
// exclusiva portátil; a verificação + reserva evita a sobrescrita em uso normal.
const nomesDestinoReservados = new WeakMap();

function nomeComSufixoColisao(nome, indice) {
    if (indice === 0) return nome;
    const ponto = nome.lastIndexOf(".");
    const base = ponto > 0 ? nome.slice(0, ponto) : nome;
    const ext = ponto > 0 ? nome.slice(ponto) : "";
    return `${base} (${indice})${ext}`;
}

function liberarReservaDestino(rec) {
    if (!rec || typeof rec.liberarNomeDestino !== "function") return;
    try { rec.liberarNomeDestino(); } catch {}
    rec.liberarNomeDestino = null;
}

function limparRecebimentoSemArquivo(sessaoId, rec) {
    liberarReservaDestino(rec);
    recebimentos.delete(sessaoId);
    ativasRecebimento.delete(sessaoId);
    if (Array.isArray(rec?.chunks)) rec.chunks.length = 0;
}

async function descartarDestinoCriadoAposFalha(dir, destino, writerHandle = null) {
    if (writerHandle) { try { await writerHandle.abort(); } catch {} }
    if (!destino) return true;
    let removido = false;
    try { await dir.removeEntry(destino.nome); removido = true; }
    catch (erro) { console.warn("Não foi possível remover a entrada criada para a gravação que falhou:", erro); }
    finally { try { destino.liberar(); } catch {} }
    return removido;
}

async function obterHandleDestinoSemSobrescrever(dir, nomeSolicitado) {
    let reservados = nomesDestinoReservados.get(dir);
    if (!reservados) { reservados = new Set(); nomesDestinoReservados.set(dir, reservados); }

    for (let indice = 0; indice < 10000; indice++) {
        const candidato = nomeComSufixoColisao(nomeSolicitado, indice);
        if (!candidato || candidato === "." || candidato === ".." || candidato.includes("/") || candidato.includes("\\")) {
            throw new Error("Nome de arquivo de destino inválido.");
        }
        if (reservados.has(candidato)) continue;
        reservados.add(candidato);

        const criarSeLivre = async () => {
            try {
                await dir.getFileHandle(candidato);
                return null; // Um arquivo com esse nome já existe.
            } catch (error) {
                if (error?.name === "TypeMismatchError") return null; // Já existe uma pasta com esse nome.
                if (error?.name !== "NotFoundError") throw error;
            }
            // navigator.locks coordena outras abas da mesma origem. A reserva local
            // cobre navegadores sem Web Locks e concorrência dentro desta instância.
            try {
                await dir.getFileHandle(candidato);
                return null;
            } catch (error) {
                if (error?.name === "TypeMismatchError") return null;
                if (error?.name !== "NotFoundError") throw error;
            }
            return await dir.getFileHandle(candidato, { create: true });
        };

        try {
            const handle = navigator.locks?.request
                ? await navigator.locks.request(`physicalcloud-destino-${candidato}`, criarSeLivre)
                : await criarSeLivre();
            if (!handle) {
                reservados.delete(candidato);
                continue;
            }
            return { handle, nome: candidato, liberar: () => reservados.delete(candidato) };
        } catch (error) {
            reservados.delete(candidato);
            if (error?.name === "TypeMismatchError") continue;
            throw error;
        }
    }
    throw new Error("Não foi possível encontrar um nome de destino que não exista.");
}

// ═══ FASE 1 / Bug #10 ═══
/** @type {Map<string, Set<string>>} */
const pullsAguardando = new Map();

/** @param {string} sessaoId @param {string} operacaoId */
function marcarPullAguardando(sessaoId, operacaoId) {
    let set = pullsAguardando.get(sessaoId);
    if (!set) { set = new Set(); pullsAguardando.set(sessaoId, set); }
    set.add(operacaoId);
    // timeout de segurança: limpa após 120s mesmo sem receber operation-start
    setTimeout(() => {
        const s = pullsAguardando.get(sessaoId);
        if (s) {
            s.delete(operacaoId);
            if (s.size === 0) pullsAguardando.delete(sessaoId);
        }
    }, TIMEOUT_OPERACAO_MS);
}

/** @param {string} sessaoId @param {string} operacaoId */
function consumirPullAguardando(sessaoId, operacaoId) {
    const set = pullsAguardando.get(sessaoId);
    if (!set) return false;
    const tinha = set.delete(operacaoId);
    if (set.size === 0) pullsAguardando.delete(sessaoId);
    return tinha;
}

/** @param {string} sessaoId */
function limparPullsAguardando(sessaoId) {
    pullsAguardando.delete(sessaoId);
}

// ─── Utilidades ───

function gerarTransferId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const b = new Uint8Array(16);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        crypto.getRandomValues(b);
    } else {
        // Último fallback para WebViews antigos sem randomUUID/getRandomValues.
        // O formato canônico permanece compatível com a validação do receptor.
        for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    }
    b[6] = (b[6] & 0x0f) | 0x40; // UUID v4
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// SHA-256 incremental: calcula o hash durante a leitura/gravação dos blocos.
// Evita crypto.subtle.digest(ArrayBuffer), que exigiria carregar o arquivo inteiro.
class Sha256Incremental {
    constructor() {
        this.h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
        this.k = Sha256Incremental.K;
        this.buffer = new Uint8Array(64);
        this.bufferLength = 0;
        this.totalBytes = 0;
        this.finished = false;
    }
    static K = new Uint32Array([
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ]);
    update(input) {
        if (this.finished) throw new Error("SHA-256 já finalizado");
        const data = input instanceof Uint8Array ? input : new Uint8Array(input);
        this.totalBytes += data.byteLength;
        let offset = 0;
        if (this.bufferLength) {
            const take = Math.min(64 - this.bufferLength, data.length);
            this.buffer.set(data.subarray(0, take), this.bufferLength);
            this.bufferLength += take;
            offset += take;
            if (this.bufferLength === 64) { this._block(this.buffer); this.bufferLength = 0; }
        }
        while (offset + 64 <= data.length) { this._block(data.subarray(offset, offset + 64)); offset += 64; }
        if (offset < data.length) { this.buffer.set(data.subarray(offset), 0); this.bufferLength = data.length - offset; }
        return this;
    }
    _block(block) {
        const w = new Uint32Array(64);
        for (let i = 0; i < 16; i++) {
            const j = i * 4;
            w[i] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            const s0 = (this._rotr(x, 7) ^ this._rotr(x, 18) ^ (x >>> 3)) >>> 0;
            const s1 = (this._rotr(y, 17) ^ this._rotr(y, 19) ^ (y >>> 10)) >>> 0;
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a,b,c,d,e,f,g,h] = this.h;
        for (let i = 0; i < 64; i++) {
            const S1 = (this._rotr(e, 6) ^ this._rotr(e, 11) ^ this._rotr(e, 25)) >>> 0;
            const ch = ((e & f) ^ (~e & g)) >>> 0;
            const t1 = (h + S1 + ch + this.k[i] + w[i]) >>> 0;
            const S0 = (this._rotr(a, 2) ^ this._rotr(a, 13) ^ this._rotr(a, 22)) >>> 0;
            const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
            const t2 = (S0 + maj) >>> 0;
            h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
        }
        this.h[0]=(this.h[0]+a)>>>0; this.h[1]=(this.h[1]+b)>>>0;
        this.h[2]=(this.h[2]+c)>>>0; this.h[3]=(this.h[3]+d)>>>0;
        this.h[4]=(this.h[4]+e)>>>0; this.h[5]=(this.h[5]+f)>>>0;
        this.h[6]=(this.h[6]+g)>>>0; this.h[7]=(this.h[7]+h)>>>0;
    }
    _rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    digest() {
        if (this.finished) throw new Error("SHA-256 já finalizado");
        // Comprimento em bits (64 bits, big-endian) sem BigInt, para WebViews antigos.
        const bitsHigh = Math.floor(this.totalBytes / 0x20000000) >>> 0;
        const bitsLow = ((this.totalBytes % 0x20000000) * 8) >>> 0;
        const tail = new Uint8Array(128);
        tail.set(this.buffer.subarray(0, this.bufferLength));
        tail[this.bufferLength] = 0x80;
        const padded = this.bufferLength < 56 ? 64 : 128;
        const view = new DataView(tail.buffer);
        view.setUint32(padded - 8, bitsHigh);
        view.setUint32(padded - 4, bitsLow);
        this._block(tail.subarray(0, 64));
        if (padded === 128) this._block(tail.subarray(64, 128));
        this.finished = true;
        return Array.from(this.h).map(x => x.toString(16).padStart(8, "0")).join("");
    }
}


/** @param {string} tipo @param {any} detalhe */
function emitir(tipo, detalhe) {
    window.dispatchEvent(new CustomEvent(tipo, { detail: detalhe }));
}

/** @param {string} sessaoId @param {string | undefined} transferId */
function limparSeProprio(sessaoId, transferId) {
    if (transferId !== undefined && transferencias.has(transferId)) transferencias.delete(transferId);
    if (ativasEnvio.get(sessaoId) === transferId) ativasEnvio.delete(sessaoId);
}

/** @param {any} entrada @param {string} sessaoId */
function emitirCancelamento(entrada, sessaoId) {
    if (entrada.cancelamentoEmitido) return;
    entrada.cancelamentoEmitido = true;
    emitir("physicalcloud:transfer-cancelado", { transferId: entrada.transferId, sessaoId });
}
// Bloco C / Bug #5:
// A função sessaoTemOperacaoAtiva foi removida. Múltiplas operações de envio
// podem coexistir na mesma sessão; elas compartilham a fila (filas[ sessaoId ])
// que já processa um arquivo por vez via processarFila, mantendo o protocolo
// binário simples (um file-offer → chunks → file-done por arquivo em voo).

// FASE 1: helpers de detecção de ambiente
function temDirectoryPicker() {
    return typeof (/** @type {any} */ (window)).showDirectoryPicker === "function";
}

// Para peers atualizados: SHA-256 nativo por bloco e um resumo incremental dos
// digests ordenados. O acumulador processa apenas 32 bytes por bloco, não o arquivo.
class Sha256ChunkIntegrity {
    constructor(totalBytes, chunkSize) {
        this.aggregate = new Sha256Incremental();
        this.totalBytes = Number(totalBytes) || 0;
        this.chunkSize = Number(chunkSize) || TAMANHO_CHUNK;
        const prefix = new TextEncoder().encode(`PhysicalCloud:SHA256-CHUNK-V1:${this.totalBytes}:${this.chunkSize}:`);
        this.aggregate.update(prefix);
    }
    async update(chunk) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        this.aggregate.update(new Uint8Array(digest));
    }
    digest() { return this.aggregate.digest(); }
}

// ─── Aguardando aceites ───

/** @param {string} transferId @param {RTCDataChannel} dc */
function aguardarAceitacao(transferId, dc) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            aguardandoAceitacaoMap.delete(transferId);
            reject(new TransferError("Tempo esgotado aguardando aceitação.", "timeout"));
        }, TIMEOUT_ACEITE_MS);
        aguardandoAceitacaoMap.set(transferId, {
            resolve: () => { clearTimeout(timeout); resolve(undefined); },
            reject: (/** @type {any} */ err) => { clearTimeout(timeout); reject(err); },
        });
        const onclose = () => {
            const p = aguardandoAceitacaoMap.get(transferId);
            if (p) {
                aguardandoAceitacaoMap.delete(transferId);
                p.reject(new TransferError("Canal fechado.", "channel-closed"));
            }
            dc.removeEventListener("close", onclose);
        };
        dc.addEventListener("close", onclose);
    });
}

/** @param {string} transferId @param {string} motivo @param {string} [tipo] */
function rejeitarAceitacaoPendente(transferId, motivo, tipo = "error") {
    const prom = aguardandoAceitacaoMap.get(transferId);
    if (prom) {
        aguardandoAceitacaoMap.delete(transferId);
        prom.reject(new TransferError(motivo || "Rejeitado", tipo, motivo));
    }
}

/** @param {string} operacaoId @param {RTCDataChannel} dc */
function aguardarDecisaoOperacao(operacaoId, dc) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            if (aguardandoOperacaoMap.has(operacaoId)) {
                aguardandoOperacaoMap.delete(operacaoId);
                resolve("timeout");
            }
        }, TIMEOUT_OPERACAO_MS);
        aguardandoOperacaoMap.set(operacaoId, {
            resolve: (/** @type {string} */ decisao) => { clearTimeout(timeout); resolve(decisao); },
        });
        const onclose = () => {
            if (aguardandoOperacaoMap.has(operacaoId)) {
                aguardandoOperacaoMap.delete(operacaoId);
                clearTimeout(timeout);
                resolve("closed");
            }
            dc.removeEventListener("close", onclose);
        };
        dc.addEventListener("close", onclose);
    });
}

/** @param {string} operacaoId @param {string} decisao */
function resolverDecisaoOperacao(operacaoId, decisao) {
    const p = aguardandoOperacaoMap.get(operacaoId);
    if (p) { aguardandoOperacaoMap.delete(operacaoId); p.resolve(decisao); }
}

// ─── Timeout de file-ok ───

/** @param {string} transferId @param {string} sessaoId */
function armarTimeoutOk(transferId, sessaoId) {
    const t = setTimeout(() => {
        timeoutsOk.delete(transferId);
        const entrada = transferencias.get(transferId);
        if (!entrada) return;
        entrada.estado = "erro";
        limparSeProprio(sessaoId, transferId);
        emitir("physicalcloud:transfer-erro", {
            transferId, sessaoId, operacaoId: entrada.operacaoId,
            motivo: "Tempo esgotado aguardando confirmação do peer.",
        });
        processarFila(sessaoId);
    }, TIMEOUT_OK_MS);
    timeoutsOk.set(transferId, t);
}

/** @param {string} transferId */
function cancelarTimeoutOk(transferId) {
    const t = timeoutsOk.get(transferId);
    if (t) { clearTimeout(t); timeoutsOk.delete(transferId); }
}

// ─── Explorador remoto ───

/** @param {FileSystemDirectoryHandle} dirHandle @param {string} [caminhoAtual] */
async function listarDiretorio(dirHandle, caminhoAtual = "") {
    const itens = [];
    for await (const entry of dirHandle.values()) {
        const caminho = caminhoAtual ? `${caminhoAtual}/${entry.name}` : entry.name;
        if (entry.kind === "file") {
            const file = await entry.getFile();
            itens.push({ nome: entry.name, caminho, tipo: "file", tamanho: file.size });
        } else {
            itens.push({ nome: entry.name, caminho, tipo: "directory", tamanho: 0 });
        }
    }
    return itens.sort((a, b) => {
        if (a.tipo !== b.tipo) return a.tipo === "directory" ? -1 : 1;
        return a.nome.localeCompare(b.nome);
    });
}

/** @param {string} sessaoId @param {string} caminhoSolicitado @param {number} paginaSolicitada @param {RTCDataChannel} dc */
async function responderListagem(sessaoId, caminhoSolicitado, paginaSolicitada, dc) {
    const raiz = pastasCompartilhadas.get(sessaoId);
    if (!raiz) {
        try {
            dc.send(JSON.stringify({
                type: "dir-list-response", caminho: caminhoSolicitado,
                pagina: 1, totalPaginas: 1, totalItens: 0, itens: [],
                erro: "Nenhuma pasta compartilhada nesta sessão. O outro dispositivo precisa autorizar uma pasta primeiro.",
            }));
        } catch {}
        return;
    }
    try {
        let alvo = raiz;
        if (caminhoSolicitado) {
            const partes = caminhoSolicitado.split("/").filter(Boolean);
            for (const parte of partes) {
                if (parte === ".." || parte === "." || parte.includes("\\")) throw new Error("Caminho inválido");
                alvo = await alvo.getDirectoryHandle(parte);
            }
        }
        const itens = await listarDiretorio(alvo, caminhoSolicitado);
        const totalPaginas = Math.max(1, Math.ceil(itens.length / TAMANHO_PAGINA));
        const pagina = Math.min(Math.max(1, paginaSolicitada || 1), totalPaginas);
        const inicio = (pagina - 1) * TAMANHO_PAGINA;
        dc.send(JSON.stringify({
            type: "dir-list-response", caminho: caminhoSolicitado,
            itens: itens.slice(inicio, inicio + TAMANHO_PAGINA),
            pagina, totalPaginas, totalItens: itens.length,
            temMais: pagina < totalPaginas,
        }));
    } catch (e) {
        console.error("Erro ao listar diretório:", e);
        try {
            dc.send(JSON.stringify({
                type: "dir-list-response", caminho: caminhoSolicitado,
                pagina: 1, totalPaginas: 1, totalItens: 0, itens: [],
                erro: "Não foi possível acessar esta pasta. Verifique se ela ainda existe.",
            }));
        } catch {}
    }
}

/** @param {string} sessaoId @param {string} caminho */
async function obterArquivoPorCaminho(sessaoId, caminho) {
    const raiz = pastasCompartilhadas.get(sessaoId);
    if (!raiz) return null;
    const partes = caminho.split("/").filter(Boolean);
    if (partes.length === 0) return null;
    for (const parte of partes) {
        if (parte === ".." || parte === "." || parte.includes("\\")) return null;
    }
    let dir = raiz;
    for (let i = 0; i < partes.length - 1; i++) dir = await dir.getDirectoryHandle(partes[i]);
    return (await dir.getFileHandle(partes[partes.length - 1])).getFile();
}

/** @param {string} sessaoId @param {string} caminho */
async function obterDiretorioPorCaminho(sessaoId, caminho) {
    const raiz = pastasCompartilhadas.get(sessaoId);
    if (!raiz) return null;
    if (!caminho) return raiz;
    const partes = caminho.split("/").filter(Boolean);
    for (const parte of partes) {
        if (parte === ".." || parte === "." || parte.includes("\\")) return null;
    }
    let dir = raiz;
    for (const parte of partes) dir = await dir.getDirectoryHandle(parte);
    return dir;
}

/** @param {FileSystemDirectoryHandle} dirHandle @param {string} [prefixo] */
async function coletarArquivosRecursivo(dirHandle, prefixo = "") {
    /** @type {Array<{ file: File, caminhoRelativo: string }>} */
    const resultado = [];
    for await (const entry of dirHandle.values()) {
        const caminhoRelativo = prefixo ? `${prefixo}/${entry.name}` : entry.name;
        if (entry.kind === "file") {
            resultado.push({ file: await entry.getFile(), caminhoRelativo });
        } else {
            resultado.push(...await coletarArquivosRecursivo(entry, caminhoRelativo));
        }
    }
    return resultado;
}

// ═══ FIM DA PARTE 1/3 ═══
// ═══ INÍCIO DA PARTE 2/3 ═══

// ─── Envio por operação ───

/**
 * @param {string} sessaoId
 * @param {Array<{ file: File, caminhoRelativo?: string }>} entradas
 * @param {string | null} [operacaoIdForcado]  // usado pelo pull para forçar o ID
 */
async function iniciarOperacaoEnvio(sessaoId, entradas, operacaoIdForcado = null) {
    const dc = canais.get(sessaoId);
    if (!dc || dc.readyState !== "open") {
        emitir("physicalcloud:transfer-erro", { sessaoId, motivo: "Canal não está aberto." });
        return null;
    }
    if (entradas.length === 0) return null;

    

    const operacaoId = operacaoIdForcado || gerarTransferId();
    const arquivos = entradas.map(e => ({
        file: e.file,
        caminhoRelativo: e.caminhoRelativo || /** @type {any} */ (e.file).webkitRelativePath || e.file.name,
        nome: e.file.name,
        tamanho: e.file.size,
        estado: "pendente",
    }));
    const totalBytes = arquivos.reduce((s, a) => s + a.tamanho, 0);
    const op = {
        operacaoId, sessaoId, direcao: "envio",
        arquivos, autorizada: false, recusada: false,
        bytesTotais: totalBytes,
        arquivosConcluidos: 0, arquivosComErro: 0,
        loteAtual: 1, totalLotes: Math.ceil(arquivos.length / TAMANHO_LOTE) || 1,
    };
    operacoes.set(operacaoId, op);

    try {
        dc.send(JSON.stringify({
            type: "operation-start", operacaoId,
            totalArquivos: arquivos.length, totalBytes,
        }));
    } catch {
        operacoes.delete(operacaoId);
        emitir("physicalcloud:transfer-erro", { sessaoId, motivo: "Falha ao iniciar operação." });
        return null;
    }

    emitir("physicalcloud:operacao-iniciada", {
        operacaoId, sessaoId, direcao: "envio",
        totalArquivos: arquivos.length, totalBytes,
        totalLotes: op.totalLotes,
    });

    const decisao = await aguardarDecisaoOperacao(operacaoId, dc);
    if (decisao === "accepted") {
        op.autorizada = true;
        let fila = filas.get(sessaoId);
        if (!fila) { fila = []; filas.set(sessaoId, fila); }
        for (const a of arquivos) fila.push({ file: a.file, operacaoId, caminhoRelativo: a.caminhoRelativo });
        processarFila(sessaoId);
        return op;
    }

    op.recusada = decisao === "refused";
    operacoes.delete(operacaoId);
    if (decisao === "refused") {
        emitir("physicalcloud:operacao-recusada", { operacaoId, sessaoId });
    } else {
        emitir("physicalcloud:operacao-cancelada", { operacaoId, sessaoId, direcao: "envio" });
    }
    return null;
}

/** @param {string} sessaoId @param {File[]} arquivos */
function enfileirarArquivos(sessaoId, arquivos) {
    const entradas = arquivos.map(f => ({
        file: f,
        caminhoRelativo: /** @type {any} */ (f).webkitRelativePath || f.name,
    }));
    iniciarOperacaoEnvio(sessaoId, entradas).catch(e => console.error("Erro ao iniciar operação:", e));
}

/**
 * @param {string} sessaoId
 * @param {Array<{ file: File, caminhoRelativo: string }>} entradas
 * @param {string | null} [operacaoIdForcado]
 */
function enfileirarArquivosComCaminho(sessaoId, entradas, operacaoIdForcado = null) {
    iniciarOperacaoEnvio(sessaoId, entradas, operacaoIdForcado)
        .catch(e => console.error("Erro ao iniciar operação (pull):", e));
}

/** @param {string} sessaoId */
function processarFila(sessaoId) {
    if (ativasEnvio.has(sessaoId)) return;
    const fila = filas.get(sessaoId);
    if (!fila || fila.length === 0) return;
    const proximo = fila.shift();
    if (proximo) enviarArquivo(sessaoId, proximo).catch(e => console.error("Erro em enviarArquivo:", e));
}

async function aguardarHashChunkDoPeer(sessaoId, limiteMs = 3000) {
    const inicio = Date.now();
    while (!peersSuportamChunkHash.has(sessaoId) && Date.now() - inicio < limiteMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return peersSuportamChunkHash.has(sessaoId);
}

async function aguardarTamanhoDesconhecidoDoPeer(sessaoId, limiteMs = 3000) {
    const inicio = Date.now();
    while (!peersSuportamTamanhoDesconhecido.has(sessaoId) && Date.now() - inicio < limiteMs) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return peersSuportamTamanhoDesconhecido.has(sessaoId);
}

/**
 * @param {string} sessaoId
 * @param {{ file: File, operacaoId: string, caminhoRelativo: string }} item
 */
async function enviarArquivo(sessaoId, item) {
    const dc = canais.get(sessaoId);
    const op = operacoes.get(item.operacaoId);
    if (!dc || dc.readyState !== "open" || !op || !op.autorizada || op.recusada) {
        processarFila(sessaoId);
        return;
    }

    const tamanhoConhecido = item.file.sizeKnown !== false &&
        Number.isSafeInteger(item.file.size) && item.file.size >= 0;
    if (!tamanhoConhecido && !peersSuportamTamanhoDesconhecido.has(sessaoId)) {
        await aguardarTamanhoDesconhecidoDoPeer(sessaoId);
        if (!peersSuportamTamanhoDesconhecido.has(sessaoId)) {
            op.arquivosComErro++;
            emitir("physicalcloud:transfer-erro", {
                sessaoId, operacaoId: op.operacaoId, nome: item.file.name,
                motivo: "O outro dispositivo não oferece suporte a arquivos cujo tamanho é desconhecido. Atualize os dois dispositivos."
            });
            processarFila(sessaoId);
            return;
        }
    }

    // Dá tempo para o peer anunciar o protocolo rápido antes de decidir o hash.
    if (tamanhoConhecido && item.file.size > 128 * 1024 * 1024 && !peersSuportamChunkHash.has(sessaoId)) {
        await aguardarHashChunkDoPeer(sessaoId);
    }

    let reader = null;
    try { reader = item.file.stream().getReader(); }
    catch {
        emitir("physicalcloud:transfer-erro", { sessaoId, nome: item.file.name, motivo: "Não foi possível ler o arquivo selecionado." });
        op.arquivosComErro++;
        processarFila(sessaoId);
        return;
    }

    // Arquivos sem tamanho conhecido usam hash incremental sobre o fluxo bruto.
    const hashAlgorithm = tamanhoConhecido && peersSuportamChunkHash.has(sessaoId)
        ? "sha256-chunk-v1" : "sha256-raw-v1";
    const LIMITE_COMPATIBILIDADE_LEGADA = 128 * 1024 * 1024;
    if (hashAlgorithm === "sha256-raw-v1" && tamanhoConhecido && item.file.size > LIMITE_COMPATIBILIDADE_LEGADA) {
        try { reader.releaseLock(); } catch {}
        op.arquivosComErro++;
        emitir("physicalcloud:transfer-erro", { sessaoId, operacaoId: op.operacaoId, nome: item.file.name, motivo: "Para transferir arquivos acima de 128 MB, atualize os dois dispositivos para a versão mais recente do Physical Cloud." });
        processarFila(sessaoId);
        return;
    }

    const transferId = gerarTransferId();
    const entrada = {
        transferId, sessaoId, operacaoId: op.operacaoId,
        nome: item.file.name, tamanho: tamanhoConhecido ? item.file.size : -1,
        tamanhoDesconhecido: !tamanhoConhecido,
        tipo: item.file.type || "application/octet-stream",
        caminhoRelativo: item.caminhoRelativo,
        enviados: 0, bytesConfirmados: 0, ackResolver: /** @type {(() => void) | null} */ (null),
        ackEnabled: false, estado: "enviando",
        tamanhoDesconhecido: !tamanhoConhecido,
        cancelarPausa: /** @type {(() => void) | null} */ (null),
        cancelamentoEmitido: false,
    };
    transferencias.set(transferId, entrada);
    ativasEnvio.set(sessaoId, transferId);

    try {
        dc.send(JSON.stringify({
            type: "file-offer", transferId, operacaoId: op.operacaoId,
            nome: item.file.name, caminhoRelativo: item.caminhoRelativo,
            tamanho: tamanhoConhecido ? item.file.size : -1,
            unknownSize: !tamanhoConhecido,
            tipo: entrada.tipo,
            hashAlgorithm, hashChunkSize: TAMANHO_CHUNK,
            ackWindow: true,
        }));
    } catch {
        try { reader.releaseLock(); } catch {}
        limparSeProprio(sessaoId, transferId);
        op.arquivosComErro++;
        processarFila(sessaoId);
        return;
    }

    emitir("physicalcloud:transfer-inicio", {
        transferId, sessaoId, operacaoId: op.operacaoId,
        nome: item.file.name, tamanho: tamanhoConhecido ? item.file.size : 0,
        tamanhoDesconhecido: !tamanhoConhecido,
        caminhoRelativo: item.caminhoRelativo, direcao: "envio",
    });

    try { await aguardarAceitacao(transferId, dc); }
    catch (/** @type {any} */ err) {
        const tipo = err?.tipo || "error";
        const motivo = err?.motivo || err?.message || "Erro desconhecido";
        try { reader.releaseLock(); } catch {}
        limparSeProprio(sessaoId, transferId);
        if (tipo === "cancel") {
            entrada.estado = "cancelado";
            emitirCancelamento(entrada, sessaoId);
        } else if (tipo === "refused") {
            entrada.estado = "recusado";
            op.arquivosComErro++;
            emitir("physicalcloud:transfer-recusado", { transferId, sessaoId, motivo });
        } else {
            entrada.estado = "erro";
            op.arquivosComErro++;
            emitir("physicalcloud:transfer-erro", { transferId, sessaoId, operacaoId: op.operacaoId, motivo });
        }
        processarFila(sessaoId);
        return;
    }

    dc.bufferedAmountLowThreshold = BUFFER_BAIXO;
    const hasherEnvio = hashAlgorithm === "sha256-chunk-v1"
        ? new Sha256ChunkIntegrity(item.file.size, TAMANHO_CHUNK)
        : new Sha256Incremental();
    const MAX_IN_FLIGHT_BYTES = 4 * 1024 * 1024;
    let pausado = false;
    /** @type {((value?: any) => void) | null} */ let resolverPausa = null;
    const liberarPausa = () => {
        if (pausado && resolverPausa) { const r = resolverPausa; pausado = false; resolverPausa = null; r(); }
    };
    const onBufferLow = () => liberarPausa();
    const onClose = () => {
        liberarPausa();
        if (entrada.ackResolver) { const r = entrada.ackResolver; entrada.ackResolver = null; r(); }
    };
    dc.addEventListener("bufferedamountlow", onBufferLow);
    dc.addEventListener("close", onClose);
    entrada.cancelarPausa = liberarPausa;

    try {
        while (true) {
            if (entrada.estado !== "enviando") break;
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            let offset = 0;
            while (offset < value.byteLength) {
                if (entrada.estado !== "enviando") break;
                if (dc.readyState !== "open") { entrada.estado = "cancelado"; break; }
                const fim = Math.min(offset + TAMANHO_CHUNK, value.byteLength);
                const fatia = new Uint8Array(fim - offset);
                fatia.set(new Uint8Array(value.buffer, value.byteOffset + offset, fim - offset));
                // Janela de recepção: não deixa o remetente ultrapassar 4 MB
                // ainda não confirmados pelo gravador do dispositivo receptor.
                while (entrada.ackEnabled && entrada.enviados - entrada.bytesConfirmados >= MAX_IN_FLIGHT_BYTES) {
                    if (entrada.estado !== "enviando" || dc.readyState !== "open") {
                        if (entrada.estado === "enviando") entrada.estado = "cancelado";
                        break;
                    }
                    await new Promise(resolve => { entrada.ackResolver = resolve; });
                }
                if (entrada.estado !== "enviando") break;
                try { dc.send(fatia); } catch { entrada.estado = "cancelado"; break; }
                await hasherEnvio.update(fatia);
                entrada.enviados += fatia.byteLength;
                emitir("physicalcloud:transfer-progresso", {
                    transferId, sessaoId, operacaoId: op.operacaoId,
                    enviados: entrada.enviados, total: tamanhoConhecido ? item.file.size : 0,
                    tamanhoDesconhecido: !tamanhoConhecido, timestamp: Date.now(),
                });
                if (dc.bufferedAmount > BUFFER_ALTO) {
                    pausado = true;
                    await new Promise((res) => { resolverPausa = res; });
                }
                offset = fim;
            }
        }
    } catch (e) {
        entrada.estado = "erro";
        try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "file-cancel", transferId })); } catch {}
        limparSeProprio(sessaoId, transferId);
        op.arquivosComErro++;
        emitir("physicalcloud:transfer-erro", { transferId, sessaoId, operacaoId: op.operacaoId, motivo: e?.message || "Falha ao calcular a integridade do arquivo." });
        processarFila(sessaoId);
        return;
    } finally {
        try { reader.releaseLock(); } catch {}
        dc.removeEventListener("bufferedamountlow", onBufferLow);
        dc.removeEventListener("close", onClose);
        entrada.cancelarPausa = null;
    }

    if (entrada.estado === "cancelado") {
        limparSeProprio(sessaoId, transferId);
        emitirCancelamento(entrada, sessaoId);
        processarFila(sessaoId);
        return;
    }
    if (entrada.estado !== "enviando") return; // erro remoto já foi tratado pelo evento file-error
    if (entrada.tamanhoDesconhecido) entrada.tamanho = entrada.enviados;

    let sha256;
    try { sha256 = hasherEnvio.digest(); }
    catch {
        entrada.estado = "erro";
        try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "file-cancel", transferId })); } catch {}
        limparSeProprio(sessaoId, transferId);
        op.arquivosComErro++;
        emitir("physicalcloud:transfer-erro", { transferId, sessaoId, operacaoId: op.operacaoId, motivo: "Falha ao calcular SHA-256." });
        processarFila(sessaoId);
        return;
    }

    if (entrada.estado === "cancelado") {
        limparSeProprio(sessaoId, transferId);
        emitirCancelamento(entrada, sessaoId);
        processarFila(sessaoId);
        return;
    }

    try {
        dc.send(JSON.stringify({ type: "file-done", transferId, sha256, bytes: entrada.enviados }));
        armarTimeoutOk(transferId, sessaoId);
    } catch {
        limparSeProprio(sessaoId, transferId);
        emitirCancelamento(entrada, sessaoId);
        processarFila(sessaoId);
    }
}

// ─── Recebimento ───

/** @param {string} sessaoId @param {any} msg @param {RTCDataChannel} dc */
function tratarOperationStart(sessaoId, msg, dc) {
    const operacaoId = typeof msg.operacaoId === "string" ? msg.operacaoId : null;
    if (!operacaoId) return;
    if (ofertasOperacoes.has(operacaoId)) return;

    const sessoes = /** @type {any} */ (window).PhysicalCloud?.sessoes;
    const sessaoInfo = sessoes ? sessoes.get(sessaoId) : null;
    const totalArquivos = Number(msg.totalArquivos) || 0;
    const totalBytes = Number(msg.totalBytes) || 0;
    const op = {
        operacaoId, sessaoId,
        nomeRemetente: sessaoInfo ? sessaoInfo.nome : "Outro dispositivo",
        totalArquivos, totalBytes,
        autorizada: false, recusada: false,
        destinoHandle: /** @type {FileSystemDirectoryHandle | null} */ (null),
        modoSalvamento: "blob",
        arquivosComErro: 0,
        dc,
    };
    ofertasOperacoes.set(operacaoId, op);

    // FASE 1 / Bug #10: auto-aceite de pull (por operacaoId esperado)
    if (consumirPullAguardando(sessaoId, operacaoId)) {
        (/** @type {any} */ (window).PhysicalCloudTransfer).aceitarOperacaoAutomatica(operacaoId).catch((/** @type {any} */ e) => {
            console.error("Falha ao auto-aceitar pull:", e);
        });
        return;
    }

    emitir("physicalcloud:operacao-recebida", {
        operacaoId, sessaoId, nomeRemetente: op.nomeRemetente,
        totalArquivos, totalBytes,
        totalLotes: Math.ceil(totalArquivos / TAMANHO_LOTE) || 1,
    });
}

/** @param {string} sessaoId @param {any} msg @param {RTCDataChannel} dc */
function tratarFileOffer(sessaoId, msg, dc) {
    const { transferId, operacaoId, nome, caminhoRelativo, tamanho, tipo } = msg;
    if (typeof transferId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(transferId)) return;
    if (typeof nome !== "string" || nome.length === 0 || nome.length > 255) return;
    const tamanhoDesconhecido = tamanho === -1 && msg.unknownSize === true && msg.hashAlgorithm === "sha256-raw-v1";
    if (!Number.isSafeInteger(tamanho) || (tamanho < 0 && !tamanhoDesconhecido) || tamanho > Number.MAX_SAFE_INTEGER) {
        try { dc.send(JSON.stringify({ type: "file-error", transferId, motivo: "Tamanho anunciado inválido." })); } catch {}
        return;
    }
    const tipoSeguro = (typeof tipo === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(tipo)) ? tipo : "application/octet-stream";
    const hashAlgorithm = msg.hashAlgorithm === "sha256-chunk-v1" ? "sha256-chunk-v1" : "sha256-raw-v1";
    const hashChunkSize = Number.isInteger(msg.hashChunkSize) && msg.hashChunkSize >= 64 * 1024 && msg.hashChunkSize <= 1024 * 1024
        ? msg.hashChunkSize : TAMANHO_CHUNK;

    if (!operacaoId || !ofertasOperacoes.has(operacaoId)) {
        if (!operacaoId) return;
        tratarOperationStart(sessaoId, { operacaoId, totalArquivos: 1, totalBytes: tamanhoDesconhecido ? 0 : tamanho }, dc);
    }
    const op = ofertasOperacoes.get(operacaoId);
    if (!op) return;
    if (op.recusada) {
        try { dc.send(JSON.stringify({ type: "file-error", transferId, motivo: "Operação recusada pelo destinatário." })); } catch {}
        return;
    }
    if (!op.autorizada) {
        ofertasPendentes.set(transferId, {
            transferId, operacaoId, sessaoId, nome,
            caminhoRelativo: typeof caminhoRelativo === "string" ? caminhoRelativo : nome,
            tamanho, tamanhoDesconhecido, tipo: tipoSeguro, hashAlgorithm, hashChunkSize, ackWindow: msg.ackWindow === true, dc,
        });
        return;
    }
    aceitarArquivoInterno({
        transferId, operacaoId, sessaoId, nome,
        caminhoRelativo: typeof caminhoRelativo === "string" ? caminhoRelativo : nome,
        tamanho, tamanhoDesconhecido, tipo: tipoSeguro, hashAlgorithm, hashChunkSize, ackWindow: msg.ackWindow === true, dc,
    });
}

// ═══ FIM DA PARTE 2/3 ═══

// ═══ INÍCIO DA PARTE 3/3 ═══

/** Abre um destino nativo em Downloads com escrita incremental (Android/Electron). */
async function criarWriterNativoDownloads(nome, tipo, caminhoRelativo) {
    const bridge = /** @type {any} */ (window).AndroidBridge;
    if (!bridge || typeof bridge.startDownloadWrite !== "function") return null;
    const parse = value => typeof value === "string" ? JSON.parse(value) : value;
    const partes = String(caminhoRelativo || nome).split(/[\\/]/).filter(Boolean);
    partes.pop(); // o nome do arquivo é passado separadamente
    const pastaRelativa = partes.join("/");
    const inicio = parse(await bridge.startDownloadWrite(nome, tipo || "application/octet-stream", pastaRelativa));
    if (!inicio || !inicio.success) throw new Error(inicio?.error || "Não foi possível criar o arquivo em Downloads.");
    const chave = inicio.streamKey || inicio.handle || inicio.fileUri;
    if (!chave) throw new Error("O armazenamento nativo não retornou um identificador de gravação.");
    let finalizado = false;
    return {
        async write(chunk) {
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            let binary = "";
            for (let i = 0; i < bytes.length; i += 8192) {
                binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 8192, bytes.length)));
            }
            const resposta = parse(await bridge.appendChunk(chave, btoa(binary)));
            if (!resposta || !resposta.success) throw new Error(resposta?.error || "Falha ao gravar bloco em Downloads.");
        },
        async close() {
            const resposta = parse(await bridge.finishFileWrite(chave));
            if (!resposta || !resposta.success) throw new Error(resposta?.error || "Falha ao finalizar arquivo em Downloads.");
            finalizado = true;
        },
        async abort() {
            if (finalizado) return;
            if (typeof bridge.abortFileWrite === "function") await bridge.abortFileWrite(chave);
            else await bridge.finishFileWrite(chave);
            finalizado = true;
        }
    };
}

/**
 * @param {{ transferId: string, operacaoId: string, sessaoId: string, nome: string, caminhoRelativo: string, tamanho: number, tipo: string, dc: RTCDataChannel }} oferta
 */
async function aceitarArquivoInterno(oferta) {
    const op = ofertasOperacoes.get(oferta.operacaoId);
    if (oferta.hashAlgorithm !== "sha256-chunk-v1" && !oferta.tamanhoDesconhecido && oferta.tamanho > 128 * 1024 * 1024) {
        try { oferta.dc.send(JSON.stringify({ type: "file-error", transferId: oferta.transferId, motivo: "O remetente está usando uma versão antiga. Atualize os dois dispositivos para transferir arquivos acima de 128 MB." })); } catch {}
        return;
    }
    if (!op || op.recusada) {
        try { oferta.dc.send(JSON.stringify({ type: "file-error", transferId: oferta.transferId, motivo: "Operação recusada." })); } catch {}
        return;
    }

    const rec = {
        transferId: oferta.transferId, operacaoId: oferta.operacaoId, sessaoId: oferta.sessaoId,
        nome: oferta.nome, caminhoRelativo: oferta.caminhoRelativo,
        tamanho: oferta.tamanho, tamanhoDesconhecido: oferta.tamanhoDesconhecido === true, tipo: oferta.tipo,
        chunks: /** @type {ArrayBuffer[]} */ ([]), recebidos: 0,
        hasher: oferta.hashAlgorithm === "sha256-chunk-v1"
            ? new Sha256ChunkIntegrity(oferta.tamanho, oferta.hashChunkSize)
            : new Sha256Incremental(),
        ultimoAck: 0, ackWindow: oferta.ackWindow === true,
        writerHandle: /** @type {FileSystemWritableFileStream | null} */ (null),
        fileHandle: /** @type {FileSystemFileHandle | null} */ (null),
        modo: "blob",
    };

    if (op.modoSalvamento === "diretorio" && op.destinoHandle) {
        try {
            const partes = oferta.caminhoRelativo.split("/").filter(Boolean);
            let dir = op.destinoHandle;
            for (let i = 0; i < partes.length - 1; i++) {
                if (partes[i] === ".." || partes[i] === "." || partes[i].includes("\\")) throw new Error("Caminho inválido");
                dir = await dir.getDirectoryHandle(partes[i], { create: true });
            }
            const nomeFinal = partes[partes.length - 1] || oferta.nome;
            let destinoCriado = null;
            try {
                destinoCriado = await obterHandleDestinoSemSobrescrever(dir, nomeFinal);
                rec.writerHandle = await destinoCriado.handle.createWritable();
                rec.fileHandle = destinoCriado.handle;
                rec.nome = destinoCriado.nome;
                rec.liberarNomeDestino = destinoCriado.liberar;
                rec.modo = "diretorio";
                if (destinoCriado.nome !== nomeFinal) {
                    emitir("physicalcloud:aviso", { mensagem: `Já existia um arquivo chamado ${nomeFinal}. O arquivo recebido será salvo como ${destinoCriado.nome}.` });
                }
            } catch (erro) {
                const removido = await descartarDestinoCriadoAposFalha(dir, destinoCriado, rec.writerHandle);
                rec.writerHandle = null;
                if (!removido && destinoCriado) emitir("physicalcloud:aviso", { mensagem: `Não foi possível remover o arquivo vazio ${destinoCriado.nome}. Verifique a pasta de destino.` });
                throw erro;
            }
        } catch (e) {
            console.error("Falha ao preparar arquivo de destino, caindo para blob:", e);
            rec.writerHandle = null; rec.fileHandle = null; rec.modo = "blob";
        }
    }

    // Em Android/Desktop, inclusive no auto-pull, usa Downloads nativo em stream.
    // Isso evita transformar um arquivo de vários GB em Base64/Blob na memória.
    if (!rec.writerHandle && typeof /** @type {any} */ (window).AndroidBridge?.startDownloadWrite === "function") {
        try {
            rec.writerHandle = /** @type {any} */ (await criarWriterNativoDownloads(oferta.nome, oferta.tipo, oferta.caminhoRelativo));
            if (rec.writerHandle) rec.modo = "native-download";
        } catch (e) {
            console.warn("Não foi possível abrir gravação nativa em Downloads:", e);
        }
    }

    // Sem um destino de disco em stream, arquivos grandes não podem cair no Blob:
    // isso poderia esgotar a memória do celular ou do navegador.
    if (!rec.writerHandle && !rec.tamanhoDesconhecido && oferta.tamanho > LIMITE_FALLBACK_RAM) {
        try { oferta.dc.send(JSON.stringify({ type: "file-error", transferId: oferta.transferId, motivo: "Este dispositivo precisa de uma pasta de destino para receber arquivos acima de 128 MB. Escolha uma pasta com espaço disponível e tente novamente." })); } catch {}
        return;
    }

    const anterior = recebimentos.get(oferta.sessaoId);
    if (anterior && anterior.transferId !== oferta.transferId && anterior.writerHandle) {
        try { await anterior.writerHandle.abort(); } catch {}
        liberarReservaDestino(anterior);
    }
    recebimentos.set(oferta.sessaoId, rec);
    ativasRecebimento.set(oferta.sessaoId, oferta.transferId);

    try {
        oferta.dc.send(JSON.stringify({ type: "file-accept", transferId: oferta.transferId, ackWindow: rec.ackWindow }));
    } catch {
        liberarReservaDestino(rec);
        if (rec.writerHandle) { try { await rec.writerHandle.abort(); } catch {} }
        recebimentos.delete(oferta.sessaoId);
        ativasRecebimento.delete(oferta.sessaoId);
        return;
    }

    emitir("physicalcloud:transfer-inicio", {
        transferId: oferta.transferId, sessaoId: oferta.sessaoId, operacaoId: oferta.operacaoId,
        nome: oferta.nome, tamanho: oferta.tamanhoDesconhecido ? 0 : oferta.tamanho,
        tamanhoDesconhecido: oferta.tamanhoDesconhecido === true,
        caminhoRelativo: oferta.caminhoRelativo, direcao: "recebimento",
    });
}

/** @param {string} sessaoId @param {ArrayBuffer} data @param {RTCDataChannel} dc */
async function tratarChunk(sessaoId, data, dc) {
    const rec = recebimentos.get(sessaoId);
    if (!rec) return;
    const bytesDoBloco = data && Number.isSafeInteger(data.byteLength) ? data.byteLength : -1;
    // O protocolo atual usa blocos de 256 KiB; tolera até 1 MiB para peers
    // compatíveis, mas nunca aceita bloco vazio/malformado ou acima do limite.
    const limiteRecebimento = rec.tamanhoDesconhecido
        ? (rec.writerHandle ? LIMITE_ARQUIVO_TAMANHO_DESCONHECIDO : LIMITE_FALLBACK_RAM)
        : rec.tamanho;
    if (bytesDoBloco <= 0 || bytesDoBloco > 1024 * 1024 || rec.recebidos + bytesDoBloco > limiteRecebimento) {
        const motivo = rec.recebidos + Math.max(0, bytesDoBloco) > limiteRecebimento
            ? (rec.tamanhoDesconhecido && !rec.writerHandle
                ? "Arquivo sem tamanho informado excedeu o limite de 128 MB para recebimento em memória. Escolha uma pasta de destino e tente novamente."
                : "O remetente excedeu o limite de tamanho do arquivo.")
            : "Bloco recebido inválido ou acima do limite.";
        try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo })); } catch {}
        try { if (rec.writerHandle) await rec.writerHandle.abort(); } catch {}
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId);
        ativasRecebimento.delete(sessaoId);
        try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "file-cancel", transferId: rec.transferId })); } catch {}
        emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo });
        return;
    }
    if (rec.writerHandle) {
        try { await rec.writerHandle.write(data); }
        catch {
            if (recebimentos.get(sessaoId) !== rec) return;
            try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Erro ao escrever no disco." })); } catch {}
            try { await rec.writerHandle.abort(); } catch {}
            liberarReservaDestino(rec);
            recebimentos.delete(sessaoId);
            ativasRecebimento.delete(sessaoId);
            emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: "Erro ao escrever no disco." });
            return;
        }
    } else {
        rec.chunks.push(data);
    }
    try { await rec.hasher.update(new Uint8Array(data)); }
    catch (e) {
        try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Falha ao calcular a integridade do bloco recebido." })); } catch {}
        if (rec.writerHandle) { try { await rec.writerHandle.abort(); } catch {} }
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId); ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: e?.message || "Falha ao calcular a integridade do bloco." });
        return;
    }
    rec.recebidos += data.byteLength;
    if (rec.ackWindow && rec.recebidos - rec.ultimoAck >= 1024 * 1024) {
        rec.ultimoAck = rec.recebidos;
        try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "file-ack", transferId: rec.transferId, bytes: rec.recebidos })); } catch {}
    }
    emitir("physicalcloud:transfer-progresso", {
        transferId: rec.transferId, sessaoId, operacaoId: rec.operacaoId,
        enviados: rec.recebidos, total: rec.tamanhoDesconhecido ? 0 : rec.tamanho,
        tamanhoDesconhecido: rec.tamanhoDesconhecido, timestamp: Date.now(),
    });
}

/** @param {string} sessaoId @param {any} msg @param {RTCDataChannel} dc */
async function tratarFileDone(sessaoId, msg, dc) {
    const rec = recebimentos.get(sessaoId);
    if (!rec || rec.transferId !== msg.transferId) return;
    const sha256Remoto = msg.sha256;

    const tamanhoFinalValidado = rec.tamanhoDesconhecido
        ? (Number.isSafeInteger(msg.bytes) && msg.bytes === rec.recebidos)
        : rec.recebidos === rec.tamanho;
    if (!tamanhoFinalValidado) {
        try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Tamanho do arquivo não confere." })); } catch {}
        if (rec.writerHandle) { try { await rec.writerHandle.abort(); } catch {} }
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId);
        ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: "Arquivo incompleto." });
        return;
    }

    if (rec.tamanhoDesconhecido) rec.tamanho = rec.recebidos;

    // O hash é calculado sobre os mesmos bytes que foram gravados, sem reler
    // o arquivo completo do armazenamento (o que causava consumo de RAM).
    let hashRecebido;
    try { hashRecebido = rec.hasher.digest(); }
    catch {
        try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Não foi possível verificar a integridade do arquivo." })); } catch {}
        if (rec.writerHandle) { try { await rec.writerHandle.abort(); } catch {} }
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId); ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: "Falha na verificação de integridade." });
        return;
    }
    if (hashRecebido !== sha256Remoto) {
        try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Falha de integridade SHA-256." })); } catch {}
        if (rec.writerHandle) { try { await rec.writerHandle.abort(); } catch {} }
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId); ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: "Arquivo corrompido." });
        return;
    }

    if (rec.writerHandle) {
        try { await rec.writerHandle.close(); }
        catch {
            try { await rec.writerHandle.abort(); } catch {}
            try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Falha ao salvar arquivo." })); } catch {}
            liberarReservaDestino(rec);
            recebimentos.delete(sessaoId);
            ativasRecebimento.delete(sessaoId);
            emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: "Falha ao salvar arquivo." });
            return;
        }
        liberarReservaDestino(rec);
        try { dc.send(JSON.stringify({ type: "file-ok", transferId: rec.transferId })); } catch {}
        recebimentos.delete(sessaoId);
        ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-concluido", {
            transferId: rec.transferId, sessaoId, operacaoId: rec.operacaoId,
            nome: rec.nome, tamanho: rec.tamanho, caminhoRelativo: rec.caminhoRelativo,
            direcao: "recebimento",
        });
        return;
    }

    const blob = new Blob(rec.chunks, { type: rec.tipo || "application/octet-stream" });
    // Bloco D / Bug #1: download neutro (sem mencionar gerenciador ou pasta).
    // Tratamos dois casos de falha:
    //  - Navegador sem suporte a <a download> → avisa o usuário
    //  - createObjectURL ou clique falha → cancela o arquivo corretamente
    // O gerenciador usado é decisão do sistema operacional, não do site.
    let downloadOk = false;
    let url = null;
    try {
        url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.rel = "noopener";
        // Verifica se o navegador respeita o atributo download
        if ("download" in a) {
            a.download = rec.nome;
        } else {
            // Sem suporte, o clique abre o arquivo na aba — não é o comportamento
            // esperado para "salvar". Avisa o usuário em vez de disparar.
            const motivo = "O navegador não suporta salvar arquivos diretamente. Abra em um navegador atualizado.";
            emitir("physicalcloud:download-falhou", { transferId: rec.transferId, sessaoId, nome: rec.nome, motivo });
            URL.revokeObjectURL(url);
            url = null;
            try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo })); } catch {}
            limparRecebimentoSemArquivo(sessaoId, rec);
            emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo });
            return;
        }
        document.body.appendChild(a);
        a.click();
        downloadOk = true;
        setTimeout(() => {
            try { document.body.removeChild(a); } catch {}
            try { if (url) URL.revokeObjectURL(url); } catch {}
        }, 5000);
    } catch (e) {
        if (url) { try { URL.revokeObjectURL(url); } catch {} }
        console.warn("Falha ao disparar download do blob:", e);
        emitir("physicalcloud:download-falhou", {
            transferId: rec.transferId, sessaoId, nome: rec.nome,
            motivo: "Não foi possível iniciar o download no navegador.",
        });
    }

    if (!downloadOk) {
        // Não envia file-ok — o emissor deve saber que o arquivo não chegou ao disco
        try { dc.send(JSON.stringify({ type: "file-error", transferId: rec.transferId, motivo: "Falha ao salvar no dispositivo." })); } catch {}
        limparRecebimentoSemArquivo(sessaoId, rec);
        emitir("physicalcloud:transfer-erro", { sessaoId, transferId: rec.transferId, operacaoId: rec.operacaoId, motivo: "Falha ao salvar no dispositivo." });
        return;
    }

    try { dc.send(JSON.stringify({ type: "file-ok", transferId: rec.transferId })); } catch {}
    recebimentos.delete(sessaoId);
    ativasRecebimento.delete(sessaoId);
    emitir("physicalcloud:transfer-concluido", {
        transferId: rec.transferId, sessaoId, operacaoId: rec.operacaoId,
        nome: rec.nome, tamanho: rec.tamanho, caminhoRelativo: rec.caminhoRelativo,
        direcao: "recebimento",
    });
}

// ─── Roteador de mensagens ───

/** @param {string} sessaoId @param {any} msg @param {RTCDataChannel} dc */
async function tratarMensagemJson(sessaoId, msg, dc) {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {

        case "operation-start":
            tratarOperationStart(sessaoId, msg, dc);
            break;

        case "operation-accept":
            resolverDecisaoOperacao(msg.operacaoId, "accepted");
            break;

        case "operation-refused":
            resolverDecisaoOperacao(msg.operacaoId, "refused");
            break;

                case "operation-cancel": {
            // Emissor: já era tratado antes (mantido).
            const opEmissor = operacoes.get(msg.operacaoId);
            if (opEmissor) {
                opEmissor.recusada = true;
                const sessaoLocal = opEmissor.sessaoId;
                const fila = filas.get(sessaoLocal);
                if (fila) {
                    for (let i = fila.length - 1; i >= 0; i--) {
                        if (fila[i].operacaoId === msg.operacaoId) fila.splice(i, 1);
                    }
                }
                const ativa = ativasEnvio.get(sessaoLocal);
                if (ativa) {
                    const e = transferencias.get(ativa);
                    if (e && e.operacaoId === msg.operacaoId) {
                        e.estado = "cancelado";
                        if (e.cancelarPausa) e.cancelarPausa();
                        try { dc.send(JSON.stringify({ type: "file-cancel", transferId: ativa })); } catch {}
                        limparSeProprio(sessaoLocal, ativa);
                        emitirCancelamento(e, sessaoLocal);
                    }
                }
                operacoes.delete(msg.operacaoId);
                emitir("physicalcloud:operacao-cancelada", {
                    operacaoId: msg.operacaoId, sessaoId: sessaoLocal,
                    direcao: "envio", motivo: "remoto",
                });
                processarFila(sessaoLocal);
            }

            // Receptor — NOVO. Era o que faltava para o bug #4.
            // Aborta writers em voo (evita arquivo 0 KB no destino) e
            // atualiza a UI com operacao-cancelada.
            const opReceptor = ofertasOperacoes.get(msg.operacaoId);
            if (opReceptor) {
                opReceptor.recusada = true;
                for (const [sid, rec] of Array.from(recebimentos.entries())) {
                    if (rec.operacaoId === msg.operacaoId) {
                        if (rec.writerHandle) {
                            try { await rec.writerHandle.abort(); } catch {}
                        }
                        liberarReservaDestino(rec);
                        recebimentos.delete(sid);
                        ativasRecebimento.delete(sid);
                        emitir("physicalcloud:transfer-cancelado", { transferId: rec.transferId, sessaoId: sid });
                    }
                }
                for (const [tid, o] of Array.from(ofertasPendentes.entries())) {
                    if (o.operacaoId === msg.operacaoId) {
                        ofertasPendentes.delete(tid);
                    }
                }
                emitir("physicalcloud:operacao-cancelada", {
                    operacaoId: msg.operacaoId,
                    sessaoId: opReceptor.sessaoId,
                    direcao: "recebimento",
                    motivo: "remoto",
                });
                ofertasOperacoes.delete(msg.operacaoId);
            }
            break;
        }

        case "file-offer":
            tratarFileOffer(sessaoId, msg, dc);
            break;

        case "transfer-capabilities": {
            if (msg.integrityVersion >= 2) peersSuportamChunkHash.add(sessaoId);
            if (msg.unknownSize === true) peersSuportamTamanhoDesconhecido.add(sessaoId);
            break;
        }

        case "file-ack": {
            const entrada = transferencias.get(msg.transferId);
            if (entrada) {
                const confirmado = Number(msg.bytes);
                if (Number.isFinite(confirmado)) entrada.bytesConfirmados = Math.max(entrada.bytesConfirmados || 0, Math.min(entrada.enviados, confirmado));
                if (entrada.ackResolver) { const resolver = entrada.ackResolver; entrada.ackResolver = null; resolver(); }
            }
            break;
        }

        case "file-accept": {
            const entradaEnvio = transferencias.get(msg.transferId);
            if (entradaEnvio) entradaEnvio.ackEnabled = msg.ackWindow === true;
            const prom = aguardandoAceitacaoMap.get(msg.transferId);
            if (prom) { aguardandoAceitacaoMap.delete(msg.transferId); prom.resolve(undefined); }
            break
                    }

        case "file-done":
            await tratarFileDone(sessaoId, msg, dc);
            break;

        case "file-cancel": {
            const rec = recebimentos.get(sessaoId);
            if (rec && rec.transferId === msg.transferId) {
                if (rec.writerHandle) { try { await rec.writerHandle.abort(); } catch {} }
                liberarReservaDestino(rec);
                recebimentos.delete(sessaoId);
                ativasRecebimento.delete(sessaoId);
                emitir("physicalcloud:transfer-cancelado", { transferId: rec.transferId, sessaoId });
            }
            const tidEnvio = ativasEnvio.get(sessaoId);
            if (tidEnvio && tidEnvio === msg.transferId) {
                const e = transferencias.get(tidEnvio);
                if (e) {
                    e.estado = "cancelado";
                    if (e.cancelarPausa) e.cancelarPausa();
                    if (e.ackResolver) { const resolver = e.ackResolver; e.ackResolver = null; resolver(); }
                    emitirCancelamento(e, sessaoId);
                }
                rejeitarAceitacaoPendente(msg.transferId, "Cancelado pelo peer.", "cancel");
                cancelarTimeoutOk(msg.transferId);
                limparSeProprio(sessaoId, msg.transferId);
                processarFila(sessaoId);
            }
            break;
        }

        case "file-ok": {
            const tid = msg.transferId;
            const entrada = transferencias.get(tid);
            if (!entrada) break;
            const op = operacoes.get(entrada.operacaoId);
            const { nome, tamanho, caminhoRelativo, operacaoId } = entrada;
            cancelarTimeoutOk(tid);
            limparSeProprio(sessaoId, tid);
            if (op) {
                op.arquivosConcluidos++;
                emitir("physicalcloud:operacao-progresso", {
                    operacaoId: op.operacaoId, sessaoId,
                    arquivosConcluidos: op.arquivosConcluidos,
                    arquivosComErro: op.arquivosComErro,
                    totalArquivos: op.arquivos.length,
                    loteAtual: Math.min(Math.ceil((op.arquivosConcluidos + op.arquivosComErro) / TAMANHO_LOTE) || 1, op.totalLotes),
                    totalLotes: op.totalLotes,
                });
                if (op.arquivosConcluidos + op.arquivosComErro >= op.arquivos.length) {
                    operacoes.delete(op.operacaoId);
                    if (op.arquivosComErro === 0) {
                        emitir("physicalcloud:operacao-concluida", {
                            operacaoId: op.operacaoId, sessaoId, direcao: "envio",
                            arquivosConcluidos: op.arquivosConcluidos,
                            arquivosComErro: 0, totalArquivos: op.arquivos.length,
                        });
                    } else {
                        emitir("physicalcloud:operacao-concluida-com-erros", {
                            operacaoId: op.operacaoId, sessaoId, direcao: "envio",
                            arquivosConcluidos: op.arquivosConcluidos,
                            arquivosComErro: op.arquivosComErro, totalArquivos: op.arquivos.length,
                        });
                    }
                }
            }
            emitir("physicalcloud:transfer-concluido", {
                transferId: tid, sessaoId, nome, tamanho, caminhoRelativo, operacaoId, direcao: "envio",
            });
            processarFila(sessaoId);
            break;
        }

        case "file-error": {
            const tid = msg.transferId;
            const motivo = msg.motivo || "Receptor reportou erro desconhecido.";
            const tipo = /recus/i.test(motivo) ? "refused" : "error";
            rejeitarAceitacaoPendente(tid, motivo, tipo);
            const entrada = transferencias.get(tid);
            if (!entrada) break;
            const op = operacoes.get(entrada.operacaoId);
            entrada.estado = "erro";
            if (entrada.cancelarPausa) entrada.cancelarPausa();
            if (entrada.ackResolver) { const resolver = entrada.ackResolver; entrada.ackResolver = null; resolver(); }
            cancelarTimeoutOk(tid);
            limparSeProprio(sessaoId, tid);
            if (op) op.arquivosComErro++;
            emitir("physicalcloud:transfer-erro", { transferId: tid, sessaoId, operacaoId: entrada.operacaoId, motivo });
            processarFila(sessaoId);
            break;
        }

        case "dir-list-request": {
            const caminho = typeof msg.caminho === "string" ? msg.caminho : "";
            const pagina = Number(msg.pagina) || 1;
            await responderListagem(sessaoId, caminho, pagina, dc);
            break;
        }

        case "dir-list-response": {
            if (msg.erro) {
                emitir("physicalcloud:lista-recebida", {
                    erro: msg.erro, caminho: msg.caminho || "",
                    pagina: msg.pagina, totalPaginas: msg.totalPaginas, totalItens: msg.totalItens,
                });
            } else {
                emitir("physicalcloud:lista-recebida", {
                    itens: msg.itens || [], caminho: msg.caminho || "",
                    pagina: msg.pagina, totalPaginas: msg.totalPaginas,
                    totalItens: msg.totalItens, temMais: !!msg.temMais,
                });
            }
            break;
        }

        case "share-folder-request":
            emitir("physicalcloud:share-folder-solicitado", { sessaoId });
            break;

        case "share-folder-response":
            emitir("physicalcloud:share-folder-resultado", {
                sessaoId, sucesso: !!msg.sucesso, erro: msg.erro || null,
            });
            break;

        case "file-pull-request": {
            const caminho = typeof msg.caminho === "string" ? msg.caminho : "";
            const tipoCaminho = msg.tipoCaminho === "directory" ? "directory" : "file";
            // FASE 1 / Bug #10: usa o transferId do pedido como operacaoId forçado.
            // O receptor já registrou esse ID em pullsAguardando — assim o auto-aceite
            // só dispara para o pull específico, nunca para uma operação alheia.
            const operacaoIdForcado = typeof msg.transferId === "string" ? msg.transferId : null;
            try {
                if (tipoCaminho === "file") {
                    const arquivo = await obterArquivoPorCaminho(sessaoId, caminho);
                    if (!arquivo) {
                        try { dc.send(JSON.stringify({ type: "file-error", transferId: operacaoIdForcado || "pull", motivo: "Arquivo não encontrado." })); } catch {}
                        return;
                    }
                    enfileirarArquivosComCaminho(sessaoId, [{ file: arquivo, caminhoRelativo: caminho }], operacaoIdForcado);
                } else {
                    const dir = await obterDiretorioPorCaminho(sessaoId, caminho);
                    if (!dir) {
                        try { dc.send(JSON.stringify({ type: "file-error", transferId: operacaoIdForcado || "pull", motivo: "Pasta não encontrada." })); } catch {}
                        return;
                    }
                    const lista = await coletarArquivosRecursivo(dir, caminho);
                    if (lista.length === 0) {
                        try { dc.send(JSON.stringify({ type: "file-error", transferId: operacaoIdForcado || "pull", motivo: "Pasta vazia." })); } catch {}
                        return;
                    }
                    enfileirarArquivosComCaminho(sessaoId, lista, operacaoIdForcado);
                }
            } catch (e) {
                console.error("Erro em file-pull-request:", e);
                try { dc.send(JSON.stringify({ type: "file-error", transferId: operacaoIdForcado || "pull", motivo: "Falha ao ler no dispositivo remetente." })); } catch {}
            }
            break;
        }
    }
}

// ─── Ciclo de vida do canal ───

window.addEventListener("physicalcloud:canal-aberto", (event) => {
    const { sessaoId, dc } = /** @type {CustomEvent} */ (event).detail;
    canais.set(sessaoId, dc);

    /** @type {{ fila: Array<() => Promise<void>>, ocupado: boolean, cancelado: boolean }} */
    const ctrl = { fila: [], ocupado: false, cancelado: false };
    controladoresFila.set(sessaoId, ctrl);

    function processar() {
        if (ctrl.cancelado || ctrl.ocupado) return;
        ctrl.ocupado = true;
        (async () => {
            while (!ctrl.cancelado && ctrl.fila.length > 0) {
                const tarefa = ctrl.fila.shift();
                if (tarefa) { try { await tarefa(); } catch (e) { console.error("Erro na fila:", e); } }
            }
            ctrl.ocupado = false;
        })();
    }

    /** @param {() => Promise<void>} fn */
    function enfileirar(fn) {
        if (ctrl.cancelado) return;
        ctrl.fila.push(fn);
        processar();
    }

    try { if (dc.readyState === "open") dc.send(JSON.stringify({ type: "transfer-capabilities", integrityVersion: 2, protocolVersion: 3, unknownSize: true })); } catch {}

    dc.addEventListener("message", (/** @type {MessageEvent} */ ev) => {
        if (typeof ev.data === "string") {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { msg = null; }
            if (msg && typeof msg.type === "string") {
                if (msg.type.startsWith("file-") || msg.type.startsWith("dir-") ||
                    msg.type.startsWith("operation-") || msg.type.startsWith("share-") ||
                    msg.type === "transfer-capabilities") {
                    enfileirar(() => tratarMensagemJson(sessaoId, msg, dc));
                }
            }
        } else if (ev.data instanceof ArrayBuffer) {
            if (ativasRecebimento.has(sessaoId)) enfileirar(() => tratarChunk(sessaoId, ev.data, dc));
        }
    });

    window.dispatchEvent(new CustomEvent("physicalcloud:sessao-pronta-para-ui", { detail: { sessaoId } }));
});

window.addEventListener("physicalcloud:sessao-encerrada", (event) => {
    const { sessaoId } = /** @type {CustomEvent} */ (event).detail;
    canais.delete(sessaoId);
    peersSuportamChunkHash.delete(sessaoId);
    peersSuportamTamanhoDesconhecido.delete(sessaoId);
    filas.delete(sessaoId);
    pastasCompartilhadas.delete(sessaoId);
    limparPullsAguardando(sessaoId);

    const ctrl = controladoresFila.get(sessaoId);
    if (ctrl) { ctrl.cancelado = true; ctrl.fila.length = 0; controladoresFila.delete(sessaoId); }

    for (const [tid, oferta] of Array.from(ofertasPendentes.entries())) {
        if (oferta.sessaoId === sessaoId) ofertasPendentes.delete(tid);
    }

        for (const [opId, op] of Array.from(operacoes.entries())) {
        if (op.sessaoId === sessaoId) {
            operacoes.delete(opId);
            emitir("physicalcloud:operacao-cancelada", {
                operacaoId: opId, sessaoId, direcao: "envio", motivo: "conexao-perdida",
            });
        }
    }
    for (const [opId, op] of Array.from(ofertasOperacoes.entries())) {
        if (op.sessaoId === sessaoId) {
            ofertasOperacoes.delete(opId);
            emitir("physicalcloud:operacao-cancelada", {
                operacaoId: opId, sessaoId, direcao: "recebimento", motivo: "conexao-perdida",
            });
        }
    }

    const tidEnvio = ativasEnvio.get(sessaoId);
    if (tidEnvio) {
        const entrada = transferencias.get(tidEnvio);
        if (entrada) {
            entrada.estado = "cancelado";
            if (entrada.cancelarPausa) entrada.cancelarPausa();
            emitirCancelamento(entrada, sessaoId);
        }
        rejeitarAceitacaoPendente(tidEnvio, "Sessão encerrada.", "channel-closed");
        cancelarTimeoutOk(tidEnvio);
        transferencias.delete(tidEnvio);
        ativasEnvio.delete(sessaoId);
    }

    const tidRec = ativasRecebimento.get(sessaoId);
    if (tidRec) {
        const rec = recebimentos.get(sessaoId);
        if (rec && rec.writerHandle) rec.writerHandle.abort().catch(() => {});
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId);
        ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-cancelado", { transferId: tidRec, sessaoId });
    }
});
// Bloco A / Bug #6: cancelamento imediato ao detectar queda de canal.
// O webrtc.js emite physicalcloud:canal-fechado assim que detecta
// DataChannel fechado, pc.failed/closed ou timeout de "disconnected".
// Aqui cancelamos TODAS as operações da sessão sem esperar o WebSocket.
window.addEventListener("physicalcloud:canal-fechado", (event) => {
    const { sessaoId, motivo } = /** @type {CustomEvent} */ (event).detail || {};
    if (!sessaoId) return;
    const motivoFinal = motivo === "canal-fechado" ? "conexao-perdida" : (motivo || "conexao-perdida");

    // Cancela envios em progresso e na fila
    for (const [opId, op] of Array.from(operacoes.entries())) {
        if (op.sessaoId !== sessaoId) continue;
        op.recusada = true;
        operacoes.delete(opId);
        emitir("physicalcloud:operacao-cancelada", {
            operacaoId: opId, sessaoId, direcao: "envio", motivo: motivoFinal,
        });
    }

    // Cancela recebimentos aguardando autorização
    for (const [opId, op] of Array.from(ofertasOperacoes.entries())) {
        if (op.sessaoId !== sessaoId) continue;
        op.recusada = true;
        ofertasOperacoes.delete(opId);
        emitir("physicalcloud:operacao-cancelada", {
            operacaoId: opId, sessaoId, direcao: "recebimento", motivo: motivoFinal,
        });
    }

    // Aborta writers ativos (arquivos parciais viram lixo descartado)
    for (const [sid, rec] of Array.from(recebimentos.entries())) {
        if (sid !== sessaoId) continue;
        if (rec.writerHandle) {
            try { rec.writerHandle.abort(); } catch {}
        }
        liberarReservaDestino(rec);
        recebimentos.delete(sid);
        ativasRecebimento.delete(sid);
        emitir("physicalcloud:transfer-cancelado", { transferId: rec.transferId, sessaoId: sid });
    }

    // Cancela envio binário ativo
    const tidEnvio = ativasEnvio.get(sessaoId);
    if (tidEnvio) {
        const e = transferencias.get(tidEnvio);
        if (e) {
            e.estado = "cancelado";
            if (e.cancelarPausa) e.cancelarPausa();
            emitirCancelamento(e, sessaoId);
        }
        transferencias.delete(tidEnvio);
        ativasEnvio.delete(sessaoId);
    }

    // Limpa tudo o mais da sessão
    filas.delete(sessaoId);
    limparPullsAguardando(sessaoId);
    for (const [tid, o] of Array.from(ofertasPendentes.entries())) {
        if (o.sessaoId === sessaoId) ofertasPendentes.delete(tid);
    }
});
// ─── Input file global (compatibilidade com evento legado) ───

window.addEventListener("physicalcloud:solicitar-envio", () => {
    if (canais.size === 0) { window.dispatchEvent(new CustomEvent("physicalcloud:transfer-sem-canal")); return; }
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.style.display = "none";
    document.body.appendChild(input);
    const removerInput = () => { if (input.parentNode) document.body.removeChild(input); };
    input.addEventListener("cancel", removerInput);
    input.addEventListener("change", () => {
        const arquivos = Array.from(input.files || []);
        removerInput();
        if (arquivos.length === 0) return;
        const sessaoIds = Array.from(canais.keys());
        if (sessaoIds.length === 1) enfileirarArquivos(sessaoIds[0], arquivos);
        else window.dispatchEvent(new CustomEvent("physicalcloud:escolher-destino", { detail: { arquivos, sessaoIds } }));
    });
    input.click();
});

// ─── Compartilhamento de pasta remoto ───

/** @param {string} sessaoId */
function solicitarCompartilhamentoRemoto(sessaoId) {
    const dc = canais.get(sessaoId);
    if (!dc || dc.readyState !== "open") return false;
    try { dc.send(JSON.stringify({ type: "share-folder-request" })); return true; }
    catch { return false; }
}

/** @param {string} sessaoId @param {boolean} sucesso @param {string} [erro] */
function notificarPastaCompartilhada(sessaoId, sucesso, erro) {
    const dc = canais.get(sessaoId);
    if (!dc || dc.readyState !== "open") return;
    try { dc.send(JSON.stringify({ type: "share-folder-response", sucesso: !!sucesso, erro: erro || null })); } catch {}
}

window.addEventListener("physicalcloud:solicitar-exploracao", (event) => {
    const { sessaoId, caminho, pagina } = /** @type {CustomEvent} */ (event).detail || {};
    if (!sessaoId) return;
    const dc = canais.get(sessaoId);
    if (!dc || dc.readyState !== "open") return;
    try {
        dc.send(JSON.stringify({ type: "dir-list-request", caminho: caminho || "", pagina: pagina || 1 }));
    } catch {}
});

// FASE 1 / Bug #10: o requestor envia o operacaoId esperado no transferId.
// O emissor (file-pull-request) usa esse mesmo ID como operacaoId forçado.
// Assim o auto-aceite é exato — nunca pega operação alheia.
window.addEventListener("physicalcloud:solicitar-download-remoto", (event) => {
    const { sessaoId, caminho, tipoCaminho } = /** @type {CustomEvent} */ (event).detail || {};
    if (!sessaoId || !caminho) return;
    const dc = canais.get(sessaoId);
    if (!dc || dc.readyState !== "open") return;
    const operacaoId = gerarTransferId();
    marcarPullAguardando(sessaoId, operacaoId);
    try {
        dc.send(JSON.stringify({
            type: "file-pull-request", caminho,
            tipoCaminho: tipoCaminho || "file",
            transferId: operacaoId,
        }));
    } catch {
        const set = pullsAguardando.get(sessaoId);
        if (set) { set.delete(operacaoId); if (set.size === 0) pullsAguardando.delete(sessaoId); }
    }
});

// Bloco B / Bug #3:
// O picker de compartilhamento NÃO é mais aberto automaticamente por este módulo.
// O evento physicalcloud:share-folder-solicitado é emitido normalmente em
// tratarMensagemJson; o index.html escuta, mostra o modal de confirmação, e só
// chama PhysicalCloudTransfer.selecionarPastaParaCompartilhar(sessaoId) após o
// clique do usuário — o que preserva o gesture exigido por showDirectoryPicker.

// ─── API pública ───

function temTransferenciaEmAndamento() {
    const recebimentoAutorizado = Array.from(ofertasOperacoes.values()).some(op => op && op.autorizada && !op.recusada);
    const existeArquivoNaFila = Array.from(filas.values()).some(fila => Array.isArray(fila) && fila.length > 0);
    return transferencias.size > 0 || recebimentos.size > 0 || operacoes.size > 0 ||
        ativasEnvio.size > 0 || ativasRecebimento.size > 0 || existeArquivoNaFila || recebimentoAutorizado;
}

async function cancelarTodasTransferencias() {
    const api = window.PhysicalCloudTransfer;
    const cancelamentos = [];

    // Interrompe primeiro as filas para impedir que um próximo arquivo comece
    // enquanto as operações atuais estão sendo canceladas.
    for (const fila of filas.values()) {
        // `filas` contém arquivos aguardando envio. Não tocar em
        // `controladoresFila`: ela processa mensagens do DataChannel e precisa
        // continuar ativa para que a sessão P2P siga utilizável.
        fila.length = 0;
    }

    const operacoesIds = new Set([...operacoes.keys(), ...ofertasOperacoes.keys()]);
    for (const operacaoId of operacoesIds) {
        try {
            const resultado = api?.cancelarOperacao?.(operacaoId);
            if (resultado && typeof resultado.then === "function") cancelamentos.push(resultado.catch(() => {}));
        } catch (erro) { console.warn("Falha ao cancelar operação:", operacaoId, erro); }
    }

    // Também cancela transferências avulsas que não pertençam a uma operação em lote.
    for (const transferId of Array.from(transferencias.keys())) {
        try {
            const resultado = api?.cancelarTransferencia?.(transferId);
            if (resultado && typeof resultado.then === "function") cancelamentos.push(resultado.catch(() => {}));
        } catch (erro) { console.warn("Falha ao cancelar transferência:", transferId, erro); }
    }
    for (const [sessaoId, rec] of Array.from(recebimentos.entries())) {
        try {
            const abort = rec.writerHandle?.abort?.();
            if (abort && typeof abort.then === "function") cancelamentos.push(abort.catch(() => {}));
        } catch {}
        liberarReservaDestino(rec);
        recebimentos.delete(sessaoId);
        ativasRecebimento.delete(sessaoId);
        emitir("physicalcloud:transfer-cancelado", { transferId: rec.transferId, sessaoId });
    }
    for (const [transferId, oferta] of Array.from(ofertasPendentes.entries())) {
        ofertasPendentes.delete(transferId);
        try { oferta.dc?.send?.(JSON.stringify({ type: "file-error", transferId, motivo: "Cancelado pelo usuário ao desativar a conexão automática." })); } catch {}
    }
    await Promise.allSettled(cancelamentos);
    emitir("physicalcloud:transferencias-canceladas", {});
}

(/** @type {any} */ (window)).PhysicalCloudTransfer = {
    enfileirarArquivos, canais, transferencias, operacoes, ofertasOperacoes,
    temTransferenciaEmAndamento,
    cancelarTodasTransferencias,
    solicitarCompartilhamentoRemoto,
        /**
     * Bloco B / Bug #8: aceita uma operação usando um handle de diretório já
     * validado (permissão "granted"). Usado pelo auto-aceite com destino padrão
     * salvo em IndexedDB. Não abre picker.
     * @param {string} operacaoId
     * @param {FileSystemDirectoryHandle} destinoHandle
     */
    async aceitarOperacaoComHandle(operacaoId, destinoHandle) {
        const op = ofertasOperacoes.get(operacaoId);
        if (!op || op.autorizada || op.recusada) return;
        if (!op.dc || op.dc.readyState !== "open") {
            ofertasOperacoes.delete(operacaoId);
            return;
        }

        op.destinoHandle = destinoHandle;
        op.modoSalvamento = "diretorio";
        op.autorizada = true;
        try { op.dc.send(JSON.stringify({ type: "operation-accept", operacaoId })); } catch {}

        emitir("physicalcloud:operacao-iniciada", {
            operacaoId, sessaoId: op.sessaoId, direcao: "recebimento",
            totalArquivos: op.totalArquivos, totalBytes: op.totalBytes,
            totalLotes: Math.ceil(op.totalArquivos / TAMANHO_LOTE) || 1,
        });

        const pendentes = Array.from(ofertasPendentes.values()).filter(o => o.operacaoId === operacaoId);
        for (const o of pendentes) {
            ofertasPendentes.delete(o.transferId);
            await aceitarArquivoInterno(o);
        }
    },

    /**
     * Bloco B / Bug #3: abre o picker no próprio dispositivo para autorizar
     * o compartilhamento de uma pasta com a sessão remota. Chamado pelo
     * index.html após confirmação do usuário (preserva o gesture).
     * @param {string} sessaoId
     * @returns {Promise<{ sucesso: boolean, erro?: string }>}
     */
    async selecionarPastaParaCompartilhar(sessaoId) {
        if (!canais.has(sessaoId)) {
            return { sucesso: false, erro: "Sessão indisponível." };
        }
        if (!temDirectoryPicker()) {
            return { sucesso: false, erro: "Este dispositivo não suporta compartilhar pasta." };
        }
        try {
            const handle = await /** @type {any} */ (window).showDirectoryPicker({ mode: "read" });
            pastasCompartilhadas.set(sessaoId, handle);
            notificarPastaCompartilhada(sessaoId, true);
            return { sucesso: true };
        } catch (e) {
            const erro = /** @type {{ name?: string, message?: string }} */ (e);
            if (erro && erro.name === "AbortError") {
                // Usuário cancelou → não notifica erro, é decisão dele
                return { sucesso: false, erro: "cancelado" };
            }
            const msg = erro?.message || "Falha ao selecionar pasta.";
            notificarPastaCompartilhada(sessaoId, false, msg);
            return { sucesso: false, erro: msg };
        }
    },

    /**
     * Bloco B / Bug #3: alternativa para dispositivos sem showDirectoryPicker
     * (Android). Envia os arquivos selecionados via input webkitdirectory como
     * uma operação de transferência normal. O solicitante recebe os arquivos
     * imediatamente (sem explorador navegável depois).
     * @param {string} sessaoId
     * @param {File[]} arquivos
     */
    compartilharArquivosSelecionados(sessaoId, arquivos) {
        if (!canais.has(sessaoId)) return;
        if (!arquivos || arquivos.length === 0) return;
        const entradas = arquivos.map(f => ({
            file: f,
            caminhoRelativo: /** @type {any} */ (f).webkitRelativePath || f.name,
        }));
        iniciarOperacaoEnvio(sessaoId, entradas).catch(e => {
            console.error("Erro ao enviar arquivos selecionados:", e);
        });
    },

    /**
     * Bloco B / Bug #3: notifica o remoto que o usuário recusou o compartilhamento.
     * @param {string} sessaoId
     * @param {string} [motivo]
     */
    recusarCompartilhamentoRemoto(sessaoId, motivo) {
        if (!canais.has(sessaoId)) return;
        notificarPastaCompartilhada(sessaoId, false, motivo || "Recusado pelo usuário.");
    },

    /**
     * FASE 1 / Bug #1:
     *  - AbortError → recusa legítima (usuário cancelou o picker)
     *  - Qualquer outro erro (SecurityError/NotAllowedError/API ausente) → cai para
     *    modo blob e prossegue com a transferência. NUNCA marca como recusada.
     * @param {string} operacaoId
     */
    async aceitarOperacao(operacaoId) {
        const op = ofertasOperacoes.get(operacaoId);
        if (!op || op.autorizada || op.recusada) return;
        if (!op.dc || op.dc.readyState !== "open") {
            ofertasOperacoes.delete(operacaoId);
            return;
        }

        let usouBlob = false;

        if (temDirectoryPicker()) {
            try {
                op.destinoHandle = await /** @type {any} */ (window).showDirectoryPicker({ mode: "readwrite" });
                op.modoSalvamento = "diretorio";
            } catch (/** @type {any} */ e) {
                const tipoErro = (e && e.name) || "";
                if (tipoErro === "AbortError") {
                    // Recusa legítima: usuário fechou o picker de propósito.
                    op.recusada = true;
                    try { op.dc.send(JSON.stringify({ type: "operation-refused", operacaoId })); } catch {}
                    resolverDecisaoOperacao(operacaoId, "refused");
                    ofertasOperacoes.delete(operacaoId);
                    for (const [tid, o] of ofertasPendentes) {
                        if (o.operacaoId === operacaoId) ofertasPendentes.delete(tid);
                    }
                    return;
                }
                // Falha de API: NUNCA recusa. Cai para blob e segue.
                console.warn("showDirectoryPicker falhou, caindo para blob:", e);
                op.modoSalvamento = "blob";
                usouBlob = true;
            }
        } else {
            op.modoSalvamento = "blob";
            usouBlob = true;
        }

        op.autorizada = true;
        try { op.dc.send(JSON.stringify({ type: "operation-accept", operacaoId })); } catch {}

        emitir("physicalcloud:operacao-iniciada", {
            operacaoId, sessaoId: op.sessaoId, direcao: "recebimento",
            totalArquivos: op.totalArquivos, totalBytes: op.totalBytes,
            totalLotes: Math.ceil(op.totalArquivos / TAMANHO_LOTE) || 1,
        });

        if (usouBlob) {
            emitir("physicalcloud:modo-salvamento-blob", {
                operacaoId, sessaoId: op.sessaoId,
                totalArquivos: op.totalArquivos,
            });
        }

        const pendentes = Array.from(ofertasPendentes.values()).filter(o => o.operacaoId === operacaoId);
        for (const o of pendentes) {
            ofertasPendentes.delete(o.transferId);
            await aceitarArquivoInterno(o);
        }
    },

    /**
     * FASE 1 / Bug #4: auto-aceite de pull.
     * Nunca tenta picker, sempre blob. Só é chamado quando o operacaoId
     * bate com um pull registrado por esta sessão (Bug #10).
     * @param {string} operacaoId
     */
    async aceitarOperacaoAutomatica(operacaoId) {
        const op = ofertasOperacoes.get(operacaoId);
        if (!op || op.autorizada || op.recusada) return;
        if (!op.dc || op.dc.readyState !== "open") {
            ofertasOperacoes.delete(operacaoId);
            return;
        }

        op.modoSalvamento = "blob";
        op.autorizada = true;
        try { op.dc.send(JSON.stringify({ type: "operation-accept", operacaoId })); } catch {}

        emitir("physicalcloud:operacao-iniciada", {
            operacaoId, sessaoId: op.sessaoId, direcao: "recebimento",
            totalArquivos: op.totalArquivos, totalBytes: op.totalBytes,
            totalLotes: Math.ceil(op.totalArquivos / TAMANHO_LOTE) || 1,
        });

        emitir("physicalcloud:modo-salvamento-blob", {
            operacaoId, sessaoId: op.sessaoId, totalArquivos: op.totalArquivos,
        });

        const pendentes = Array.from(ofertasPendentes.values()).filter(o => o.operacaoId === operacaoId);
        for (const o of pendentes) {
            ofertasPendentes.delete(o.transferId);
            await aceitarArquivoInterno(o);
        }
    },

    /** @param {string} operacaoId */
    recusarOperacao(operacaoId) {
        const op = ofertasOperacoes.get(operacaoId);
        if (!op) return;
        op.recusada = true; op.autorizada = false;
        try { op.dc.send(JSON.stringify({ type: "operation-refused", operacaoId })); } catch {}
        resolverDecisaoOperacao(operacaoId, "refused");
        for (const [tid, o] of ofertasPendentes) {
            if (o.operacaoId === operacaoId) {
                ofertasPendentes.delete(tid);
                try { o.dc.send(JSON.stringify({ type: "file-error", transferId: tid, motivo: "Recusado pelo usuário." })); } catch {}
            }
        }
        ofertasOperacoes.delete(operacaoId);
    },

    /**
     * FASE 1 / Bug #11: cancela operação no emissor ou receptor.
     * No receptor, aborta writers em voo e notifica o emissor.
     * @param {string} operacaoId
     */
    cancelarOperacao(operacaoId) {
        const opEnvio = operacoes.get(operacaoId);
        if (opEnvio) {
            opEnvio.recusada = true;
            const sessaoId = opEnvio.sessaoId;
            const dc = canais.get(sessaoId);

            if (dc && dc.readyState === "open") {
                try { dc.send(JSON.stringify({ type: "operation-cancel", operacaoId })); } catch {}
            }
            const fila = filas.get(sessaoId);
            if (fila) {
                for (let i = fila.length - 1; i >= 0; i--) {
                    if (fila[i].operacaoId === operacaoId) fila.splice(i, 1);
                }
            }
            const ativa = ativasEnvio.get(sessaoId);
            if (ativa) {
                const e = transferencias.get(ativa);
                if (e && e.operacaoId === operacaoId) {
                    e.estado = "cancelado";
                    if (e.cancelarPausa) e.cancelarPausa();
                    emitirCancelamento(e, sessaoId);
                    if (dc && dc.readyState === "open") {
                        try { dc.send(JSON.stringify({ type: "file-cancel", transferId: ativa })); } catch {}
                    }
                    limparSeProprio(sessaoId, ativa);
                }
            }
            operacoes.delete(operacaoId);
            emitir("physicalcloud:operacao-cancelada", { operacaoId, sessaoId, direcao: "envio" });
            processarFila(sessaoId);
            return;
        }

        const opRec = ofertasOperacoes.get(operacaoId);
        if (opRec) {
            opRec.recusada = true;
            try { opRec.dc.send(JSON.stringify({ type: "operation-cancel", operacaoId })); } catch {}
            const aborts = [];

            for (const [sid, rec] of Array.from(recebimentos.entries())) {
                if (rec.operacaoId === operacaoId) {
                    if (rec.writerHandle) {
                        try { aborts.push(Promise.resolve(rec.writerHandle.abort()).catch(() => {})); } catch {}
                    }
                    liberarReservaDestino(rec);
                    recebimentos.delete(sid);
                    ativasRecebimento.delete(sid);
                    emitir("physicalcloud:transfer-cancelado", { transferId: rec.transferId, sessaoId: sid });
                }
            }

            for (const [tid, o] of Array.from(ofertasPendentes.entries())) {
                if (o.operacaoId === operacaoId) {
                    ofertasPendentes.delete(tid);
                    try { o.dc.send(JSON.stringify({ type: "file-error", transferId: tid, motivo: "Cancelado pelo receptor." })); } catch {}
                }
            }

            emitir("physicalcloud:operacao-cancelada", { operacaoId, sessaoId: opRec.sessaoId, direcao: "recebimento" });
            ofertasOperacoes.delete(operacaoId);
            return Promise.allSettled(aborts);
        }
        return Promise.resolve();
    },

    /** @param {any} transferId */
    cancelarTransferencia(transferId) {
        if (!transferId) return Promise.resolve();
        let sessaoId = null, sentido = null;
        for (const [sid, tid] of ativasEnvio) { if (tid === transferId) { sessaoId = sid; sentido = "envio"; break; } }
        if (!sessaoId) { for (const [sid, tid] of ativasRecebimento) { if (tid === transferId) { sessaoId = sid; sentido = "recebimento"; break; } } }
        if (!sessaoId || !sentido) return;
        const dc = canais.get(sessaoId);
        if (dc && dc.readyState === "open") { try { dc.send(JSON.stringify({ type: "file-cancel", transferId })); } catch {} }
        if (sentido === "envio") {
            const entrada = transferencias.get(transferId);
            if (entrada) {
                entrada.estado = "cancelado";
                if (entrada.cancelarPausa) entrada.cancelarPausa();
                emitirCancelamento(entrada, sessaoId);
            }
            rejeitarAceitacaoPendente(transferId, "Cancelado pelo usuário.", "cancel");
            cancelarTimeoutOk(transferId);
            limparSeProprio(sessaoId, transferId);
            processarFila(sessaoId);
        } else {
            const rec = recebimentos.get(sessaoId);
            let abort = Promise.resolve();
            if (rec && rec.transferId === transferId) {
                if (rec.writerHandle) abort = Promise.resolve(rec.writerHandle.abort()).catch(() => {});
                liberarReservaDestino(rec);
                recebimentos.delete(sessaoId);
            }
            ativasRecebimento.delete(sessaoId);
            emitir("physicalcloud:transfer-cancelado", { transferId, sessaoId });
            return abort;
        }
        return Promise.resolve();
    },
};

// ═══ FIM DA PARTE 3/3 ═══