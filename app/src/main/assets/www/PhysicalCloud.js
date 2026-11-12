// @ts-check

const URL_SERVIDOR = "wss://physical-cloud-server.onrender.com";
const TEMPO_PEDIDO_S = 60;
const DIAS_EXPIRACAO_CONHECIDOS = 90;

const telaDeCodigo        = document.getElementById("modal-codigo");
const codigoTexto         = document.getElementById("codigo-texto");
const fecharModal         = document.getElementById("btn-fechar-modal");
const telaDeConectar      = document.getElementById("modal-conectar");
const fecharModalConectar = document.getElementById("btn-fechar-conectar");

/** @type {HTMLInputElement[]} */
const inputs = Array.from(document.querySelectorAll("input.code-input-box"));

/** @type {WebSocket | null} */
let socket = null;

/** @type {string | null} */
let meuCodigoServidor = null;

let souServidor = false;
let abrirModalAoGerar = false;
let aguardandoAprovacao = false;

/** @type {string | null} */
let sessaoAguardando = null;

/** @type {Map<string, {papel: string, nome: string, permissao: string, deviceId?: string}>} */
const sessoes = new Map();

/** @type {ReturnType<typeof setInterval> | null} */
let pingInterval = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let timerReconexao = null;
let tentativasReconexao = 0;
let reconectando = false;


// Credencial persistente emitida pelo servidor (32 bytes aleatórios, base64url).
// O deviceId é público; somente este token comprova a posse da identidade.
const AUTH_TOKEN_STORAGE_KEY = "physicalCloudDeviceAuthToken";
let authTokenMemoria = null;
let identidadeAutenticada = false;
let bloqueioIdentidade = false;

function obterTokenAutenticacao() {
    if (authTokenMemoria) return authTokenMemoria;
    try {
        const salvo = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
        if (salvo && /^[A-Za-z0-9_-]{43}$/.test(salvo)) {
            authTokenMemoria = salvo;
            return salvo;
        }
        if (salvo) localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    } catch { /* O servidor recusará a conexão se a credencial não puder ser persistida. */ }
    return null;
}

function verificarArmazenamentoAutenticacao() {
    const chaveTeste = `${AUTH_TOKEN_STORAGE_KEY}:teste`;
    try {
        localStorage.setItem(chaveTeste, "1");
        const disponivel = localStorage.getItem(chaveTeste) === "1";
        localStorage.removeItem(chaveTeste);
        return disponivel;
    } catch {
        try { localStorage.removeItem(chaveTeste); } catch {}
        return false;
    }
}

function salvarTokenAutenticacao(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
        if (localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) !== token) return false;
        authTokenMemoria = token;
        return true;
    } catch {
        return false;
    }
}

// ─── Identificação do dispositivo ────────────────────────────────────────────

/** @type {string | null} */
let deviceIdMemoria = null;

function gerarId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function obterDeviceId() {
    if (deviceIdMemoria) return deviceIdMemoria;
    /** @type {string | null} */
    let id = null;
    try { id = localStorage.getItem("physicalCloudDeviceId"); } catch { /* private mode */ }
    if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
        id = gerarId();
        try { localStorage.setItem("physicalCloudDeviceId", id); } catch { /* sem storage */ }
    }
    deviceIdMemoria = id;
    return id;
}

function obterNomeDispositivo() {
    try {
        const salvo = localStorage.getItem("physicalCloudNomeDispositivo");
        if (salvo) return salvo;
    } catch { /* noop */ }
    
    const ua = navigator.userAgent;
    if (/Android/i.test(ua)) return "Celular Android";
    if (/iPhone|iPad/i.test(ua)) return "iPhone/iPad";
    if (/Windows/i.test(ua)) return "PC Windows";
    if (/Mac/i.test(ua)) return "Mac";
    if (/Linux/i.test(ua)) return "PC Linux";
    return "Dispositivo";
}

// ─── Memória de dispositivos conhecidos ──────────────────────────────────────

/**
 * @typedef {{ deviceId: string, nome: string, papel: string, ultimaConexao: number }} DispositivoConhecido
 */

/** @returns {DispositivoConhecido[]} */
function obterDispositivosConhecidos() {
    try {
        const raw = localStorage.getItem("physicalCloudDispositivosConhecidos");
        if (!raw) return [];
        let lista = JSON.parse(raw);
        if (!Array.isArray(lista)) return [];
        
        const limite = Date.now() - (DIAS_EXPIRACAO_CONHECIDOS * 24 * 60 * 60 * 1000);
        const antes = lista.length;
        lista = lista.filter(d => d.ultimaConexao && d.ultimaConexao > limite);
        
        if (lista.length !== antes) {
            localStorage.setItem("physicalCloudDispositivosConhecidos", JSON.stringify(lista));
        }
        return lista.sort(/** @param {DispositivoConhecido} a @param {DispositivoConhecido} b */ (a, b) => b.ultimaConexao - a.ultimaConexao);
    } catch {
        return [];
    }
}

/**
 * @param {string} deviceId
 * @param {string} nome
 * @param {string} papel  "cliente" ou "servidor"
 */
function salvarDispositivoConhecido(deviceId, nome, papel) {
    if (!deviceId) return;
    try {
        const lista = obterDispositivosConhecidos();
        const idx = lista.findIndex(d => d.deviceId === deviceId);
        const novoItem = { deviceId, nome, papel, ultimaConexao: Date.now() };
        
        if (idx >= 0) {
            lista[idx] = novoItem;
        } else {
            lista.push(novoItem);
        }
        
        localStorage.setItem("physicalCloudDispositivosConhecidos", JSON.stringify(lista));
        atualizarListaDispositivos();
    } catch { /* noop */ }
}

/** @param {string} novoNome */
function atualizarNomeLocal(novoNome) {
    try { localStorage.setItem("physicalCloudNomeDispositivo", novoNome); } catch { /* noop */ }
    enviar({ type: "atualizar-nome", nome: novoNome });
}

/** @param {string} sessaoId */
function abrirModalEditarNome(sessaoId) {
    const s = sessoes.get(sessaoId);
    if (!s) return;
    
    // Usa o prompt nativo apenas para simplificar - se preferir um modal, o index.html cuidará disso
    const novo = prompt("Digite o novo nome para este dispositivo:", s.nome);
    if (novo && novo.trim() && novo.trim() !== s.nome) {
        s.nome = novo.trim().slice(0, 40);
        atualizarListaDispositivos();
    }
}

// ─── Envio e avisos ──────────────────────────────────────────────────────────

/**
 * @param {any} obj
 */
function enviar(obj) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // Apenas a identificação inicial pode ser enviada antes da prova de posse.
    if (!identidadeAutenticada && obj?.type !== "identificar") return false;
    socket.send(JSON.stringify(obj));
    return true;
}

/** @type {HTMLElement | null} */
let areaAvisos = null;

/**
 * @param {string | null} texto
 */
function aviso(texto) {
    if (!areaAvisos) {
        areaAvisos = document.createElement("div");
        Object.assign(areaAvisos.style, {
            position: "fixed", left: "50%", bottom: "24px", transform: "translateX(-50%)",
            display: "flex", flexDirection: "column", gap: "8px", zIndex: "10000",
            maxWidth: "90vw", pointerEvents: "none",
        });
        document.body.appendChild(areaAvisos);
    }
    const el = document.createElement("div");
    el.textContent = texto;
    Object.assign(el.style, {
        background: "#1b1b1b", color: "#fff", border: "1px solid #1f7a4d",
        borderRadius: "10px", padding: "10px 16px", fontSize: "14px", textAlign: "center",
    });
    areaAvisos.appendChild(el);
    setTimeout(() => el.remove(), 4500);
}

const MOTIVOS_ENCERRAMENTO = {
    "recusado": "O dispositivo recusou a conexão.",
    "pedido-expirou": "O pedido de conexão expirou sem resposta.",
    "dispositivo-desconectou": "O outro dispositivo foi desconectado.",
    "encerrado-pelo-dispositivo": "O outro dispositivo encerrou a conexão.",
};
/** @type {Record<string, string>} */
const TEXTO_PERMISSAO = {
    "leitura": "só leitura",
    "leitura-escrita": "leitura e escrita",
};

// ─── Lista de dispositivos ────────────────────────────────────────────────────

const listaDispositivos = document.getElementById("lista-dispositivos");
const emptyDispositivos = document.getElementById("empty-dispositivos");
const deviceActions     = document.getElementById("device-actions");
const listaConhecidos   = document.getElementById("lista-conhecidos"); // Adicionado no HTML
const containerConhecidos = document.getElementById("conhecidos-container"); // Adicionado no HTML

// Adicione estas duas funções antes de atualizarListaDispositivos
/**
 * @param {string | number} deviceId
 */
function obterAlias(deviceId) {
    try {
        const aliases = JSON.parse(localStorage.getItem("physicalCloudAliases") || "{}");
        return aliases[deviceId] || null;
    } catch { return null; }
}

/**
 * @param {string | number} deviceId
 * @param {any} novoNome
 */
function salvarAlias(deviceId, novoNome) {
    if (!deviceId) return;
    try {
        // Salva nos aliases (para a sessão atual)
        const aliases = JSON.parse(localStorage.getItem("physicalCloudAliases") || "{}");
        aliases[deviceId] = novoNome;
        localStorage.setItem("physicalCloudAliases", JSON.stringify(aliases));

        // Atualiza o nome na lista de dispositivos conhecidos
        const lista = obterDispositivosConhecidos();
        const idx = lista.findIndex(d => d.deviceId === deviceId);
        if (idx >= 0) {
            lista[idx].nome = novoNome;
            localStorage.setItem("physicalCloudDispositivosConhecidos", JSON.stringify(lista));
        }
        
        // Força a tela a atualizar para mostrar o nome novo
        atualizarListaDispositivos();
    } catch (e) {
        console.error("Erro ao salvar apelido:", e);
    }
}

// Substitua a função atualizarListaDispositivos INTEIRA por esta:
function atualizarListaDispositivos() {
    if (!listaDispositivos || !emptyDispositivos) return;
    
    // 1. Atualiza Conectados
    listaDispositivos.innerHTML = "";
    if (sessoes.size === 0) {
        emptyDispositivos.style.display = "";
        listaDispositivos.style.display = "none";
        if (deviceActions) deviceActions.style.display = "none";
    } else {
        emptyDispositivos.style.display = "none";
        listaDispositivos.style.display = "";
        if (deviceActions) deviceActions.style.display = "";

        for (const [sessaoId, s] of sessoes) {
            const card = document.createElement("div");
            card.className = "device-card";
            card.dataset.sessaoId = sessaoId;

            const icone = document.createElement("div");
            icone.className = "device-icon";
            icone.innerHTML = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 28px; height: 28px; color: var(--accent);"><path d="M8 17H3.5C3.22386 17 3 16.7761 3 16.5V5.5C3 5.22386 3.22386 5 3.5 5H16.5C16.7761 5 17 5.22386 17 5.5V9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M2 19H18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><rect x="12" y="9" width="9" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M15 17H18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
            
            const info = document.createElement("div");
            info.className = "device-info";

            const nomeWrap = document.createElement("div");
            nomeWrap.style.display = "flex";
            nomeWrap.style.alignItems = "center";
            nomeWrap.style.gap = "8px";

            const nome = document.createElement("span");
            nome.className = "device-name";
            nome.textContent = s.nome;

            // O novo botão de Editar Nome
            const btnEdit = document.createElement("button");
            btnEdit.className = "secondary-btn";
            btnEdit.style.padding = "2px 8px";
            btnEdit.style.fontSize = "11px";
            btnEdit.textContent = "Editar nome";
                        btnEdit.addEventListener("click", (e) => {
                e.stopPropagation();
                /** @type {any} */ (window).abrirModalEditarNome?.(sessaoId, s.nome);
            });

            nomeWrap.append(nome, btnEdit);

            const detalhes = document.createElement("span");
            detalhes.className = "device-details";
            // @ts-ignore
            const permissaoTexto = TEXTO_PERMISSAO[s.permissao] || s.permissao;
            detalhes.textContent = s.papel === "servidor"
                ? `Conectado a você · ${permissaoTexto}`
                : `Você conectado · ${permissaoTexto}`;

            info.append(nomeWrap, detalhes);

            const badge = document.createElement("span");
            badge.className = "device-badge device-badge--online";
            badge.textContent = "Online";

            const btnEncerrar = document.createElement("button");
            btnEncerrar.className = "device-btn-encerrar";
            btnEncerrar.textContent = "Desconectar";
            btnEncerrar.addEventListener("click", () => encerrarSessao(sessaoId));

            card.append(icone, info, badge, btnEncerrar);
            listaDispositivos.appendChild(card);
        }
    }

    // 2. Atualiza Conhecidos (Fora do if/else para aparecer mesmo desconectado)
    if (listaConhecidos && containerConhecidos) {
        const conhecidos = obterDispositivosConhecidos();
        if (conhecidos.length === 0) {
            containerConhecidos.style.display = "none";
        } else {
            containerConhecidos.style.display = "";
            listaConhecidos.innerHTML = "";
            for (const d of conhecidos) {
                // Se já estiver conectado, não mostra na lista de conhecidos
                const jaConectado = Array.from(sessoes.values()).some(s => s.deviceId === d.deviceId);
                if (jaConectado) continue;

                const card = document.createElement("div");
                card.className = "device-card known-card";

                const info = document.createElement("div");
                info.className = "device-info";
                const nome = document.createElement("span");
                nome.className = "device-name";
                nome.textContent = d.nome;
                const det = document.createElement("span");
                det.className = "device-details";
                const dataFormatada = new Date(d.ultimaConexao).toLocaleDateString();
                det.textContent = `Visto por último: ${dataFormatada}`;
                info.append(nome, det);

                const btnReconectar = document.createElement("button");
                btnReconectar.className = "primary-btn";
                btnReconectar.style.padding = "6px 12px";
                btnReconectar.style.fontSize = "12px";
                btnReconectar.textContent = "Reconectar";
                btnReconectar.addEventListener("click", () => {
                    if (!socket || socket.readyState !== WebSocket.OPEN) {
                        aviso("Sem conexão com o servidor.");
                        return;
                    }
                    enviar({
                        type: "reconectar",
                        deviceId: obterDeviceId(),
                        deviceIdAlvo: d.deviceId,
                        nome: obterNomeDispositivo()
                    });
                    aviso(`Tentando reconectar a ${d.nome}...`);
                });

                card.append(info, btnReconectar);
                listaConhecidos.appendChild(card);
            }
        }
    }
}

// ─── Abrir modal ─────────────────────────────────────────────────────────────

function abrirModalConectar() {
    if (aguardandoAprovacao) {
        aviso("Aguarde a resposta do dispositivo atual antes de tentar outro.");
        return;
    }
    limparInputs();
    telaDeConectar?.classList.add("active");
    inputs[0]?.focus();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll(".nav-item[data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
        const alvo = /** @type {HTMLElement} */ (btn).dataset.tab;
        if (!alvo) return;
        document.querySelectorAll(".nav-item").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(alvo)?.classList.add("active");
    });
});

// ─── Contagem do código ─────────────────────────────────────────────────────

/** @type {HTMLElement | null} */
let elContagem = null;
/** @type {HTMLButtonElement | null} */
let btnNovoCodigo = null;
/** @type {HTMLButtonElement | null} */
let btnPararServidor = null;
let fimCodigo = 0;
/** @type {ReturnType<typeof setInterval> | null} */
let timerCodigo = null;

function prepararExtrasDoModalCodigo() {
    if (!codigoTexto || elContagem) return;

    elContagem = document.createElement("p");
    elContagem.id = "codigo-contagem";
    Object.assign(elContagem.style, { opacity: "0.8", fontSize: "14px", margin: "18px 0 8px" });

    btnNovoCodigo = document.createElement("button");
    btnNovoCodigo.type = "button";
    btnNovoCodigo.id = "btn-novo-codigo";
    btnNovoCodigo.textContent = "Gerar novo código";
    Object.assign(btnNovoCodigo.style, {
        background: "transparent", color: "inherit", border: "1px solid #1f7a4d",
        borderRadius: "8px", padding: "6px 14px", cursor: "pointer", display: "block", margin: "8px auto 0",
    });
    btnNovoCodigo.addEventListener("click", () => {
        abrirModalAoGerar = true;
        if (!enviar({ type: "tornar-servidor", deviceId: obterDeviceId() })) {
            abrirModalAoGerar = false;
            aviso("Servidor desconectado. Aguarde a reconexão.");
        }
    });

    btnPararServidor = document.createElement("button");
    btnPararServidor.type = "button";
    btnPararServidor.id = "btn-parar-servidor";
    btnPararServidor.textContent = "Parar de ser servidor";
    Object.assign(btnPararServidor.style, {
        background: "transparent", color: "#ff6b6b", border: "1px solid #ff6b6b",
        borderRadius: "8px", padding: "6px 14px", cursor: "pointer",
        display: "block", margin: "8px auto 0", fontSize: "13px",
    });
    btnPararServidor.addEventListener("click", () => {
        pararServidor();
        aviso("Este dispositivo não é mais servidor. Recarregue para conectar como cliente.");
    });

    codigoTexto.parentElement?.append(elContagem, btnNovoCodigo, btnPararServidor);
}

function mostrarDigitos(codigo = "") {
    const caixas = document.querySelectorAll("#modal-codigo .code-digit");
    caixas.forEach((caixa, i) => { caixa.textContent = codigo[i] || ""; });
}

function pararContagem() {
    if (timerCodigo) clearInterval(timerCodigo);
    timerCodigo = null;
}

function atualizarContagem() {
    const restante = Math.max(0, Math.ceil((fimCodigo - Date.now()) / 1000));
    if (elContagem) {
        if (restante > 0) {
            const m = Math.floor(restante / 60);
            const s = String(restante % 60).padStart(2, "0");
            elContagem.textContent = `Expira em ${m}:${s}`;
        } else {
            elContagem.textContent = "Código expirado. Gere um novo.";
        }
    }
    if (restante === 0) pararContagem();
}

/** @param {number} segundos */
function iniciarContagem(segundos) {
    pararContagem();
    fimCodigo = Date.now() + segundos * 1000;
    atualizarContagem();
    timerCodigo = setInterval(atualizarContagem, 1000);
}

// ─── Pedidos de conexão ─────────────────────────────────────────────────────

/** @type {{sessaoId: string, nome: string, chegouEm: number, via: string}[]} */
const filaPedidos = [];
/** @type {HTMLElement | null} */
let dialogoPedido = null;
/** @type {ReturnType<typeof setInterval> | null} */
let timerPedido = null;

function fecharDialogoPedido() {
    if (timerPedido) clearInterval(timerPedido);
    timerPedido = null;
    if (dialogoPedido) dialogoPedido.remove();
    dialogoPedido = null;
}

/** @param {boolean} aceitar @param {string} permissao */
function responderPedido(aceitar, permissao) {
    const pedido = filaPedidos[0];
    if (!pedido) return;
    if (pedido.expiraEm && Date.now() >= pedido.expiraEm) {
        removerPedido(pedido.sessaoId);
        aviso("Este pedido já expirou. Solicite uma nova conexão.");
        return;
    }
    filaPedidos.shift();
    enviar({ type: "responder-pedido", sessaoId: pedido.sessaoId, aceitar, permissao });
    fecharDialogoPedido();
    mostrarProximoPedido();
}

function mostrarProximoPedido() {
    if (dialogoPedido) return;
    const pedido = filaPedidos[0];
    if (!pedido) return;

    const fundo = document.createElement("div");
    Object.assign(fundo.style, {
        position: "fixed", inset: "0", background: "rgba(0,0,0,0.65)", display: "flex",
        alignItems: "center", justifyContent: "center", zIndex: "9999",
    });

    const caixa = document.createElement("div");
    Object.assign(caixa.style, {
        background: "#111", color: "#fff", border: "1px solid #2a2a2a", borderRadius: "16px",
        padding: "24px", width: "min(380px, 90vw)", textAlign: "center",
    });

    const titulo = document.createElement("h3");
    titulo.textContent = "Permitir conexão?";
    titulo.style.margin = "0 0 12px";

    const texto = document.createElement("p");
    texto.textContent = `"${pedido.nome}" quer acessar a pasta deste dispositivo.`;
    if (pedido.via === "reconexao") {
        texto.textContent = `"${pedido.nome}" quer reconectar a este dispositivo.`;
    }

    const contagem = document.createElement("p");
    Object.assign(contagem.style, { opacity: "0.7", fontSize: "13px" });

       const botoes = document.createElement("div");
    Object.assign(botoes.style, { display: "flex", gap: "12px", justifyContent: "center", marginTop: "16px" });

    const btnPermitir = document.createElement("button");
    btnPermitir.type = "button";
    btnPermitir.textContent = "Permitir";
    Object.assign(btnPermitir.style, {
        background: "#1f7a4d", color: "#fff", border: "none", borderRadius: "10px",
        padding: "10px 20px", cursor: "pointer",
    });
    // Agora envia direto "leitura-escrita" sem perguntar
    btnPermitir.addEventListener("click", () => responderPedido(true, "leitura-escrita"));

    const btnRecusar = document.createElement("button");
    btnRecusar.type = "button";
    btnRecusar.textContent = "Recusar";
    Object.assign(btnRecusar.style, {
        background: "#2a2a2a", color: "#fff", border: "none", borderRadius: "10px",
        padding: "10px 20px", cursor: "pointer",
    });
    btnRecusar.addEventListener("click", () => responderPedido(false, "leitura"));

    botoes.append(btnPermitir, btnRecusar);
    
    // Removemos o 'rotulo' do append, deixando só titulo, texto, contagem e botoes
    caixa.append(titulo, texto, contagem, botoes);
    fundo.appendChild(caixa);
    document.body.appendChild(fundo);
    dialogoPedido = fundo;
    const atualizar = () => {
        const restante = Math.max(0, Math.ceil(((pedido.expiraEm || (pedido.chegouEm + TEMPO_PEDIDO_S * 1000)) - Date.now()) / 1000));
        contagem.textContent = restante > 0 ? `Expira em ${restante}s` : "Pedido expirado. Aguardando confirmação do servidor…";
        btnPermitir.disabled = restante === 0;
        btnRecusar.disabled = restante === 0;
        if (restante === 0) {
            btnPermitir.style.opacity = "0.45";
            btnRecusar.style.opacity = "0.45";
            if (timerPedido) clearInterval(timerPedido);
            timerPedido = null;
        }
    };
    atualizar();
    if (pedido.expiraEm > Date.now()) timerPedido = setInterval(atualizar, 1000);
}

/**
 * @param {string} sessaoId
 */
function removerPedido(sessaoId) {
    const posicao = filaPedidos.findIndex(p => p.sessaoId === sessaoId);
    if (posicao === -1) return;
    const eraOAberto = posicao === 0 && dialogoPedido !== null;
    filaPedidos.splice(posicao, 1);
    if (eraOAberto) {
        fecharDialogoPedido();
        mostrarProximoPedido();
    }
}

// ─── Inputs do código ─────────────────────────────────────────────────────────

function limparInputs() {
    inputs.forEach(input => { input.value = ""; });
}

function enviarCodigoSeCompleto() {
    if (!inputs.every(input => input.value !== "")) return;
    if (aguardandoAprovacao) return;

    const codigo = inputs.map(input => input.value).join("");

    if (meuCodigoServidor !== null && codigo === meuCodigoServidor) {
        aviso("Você não pode conectar ao próprio dispositivo servidor.");
        limparInputs();
        inputs[0].focus();
        return;
    }

    const enviado = enviar({
        type: "conectar", codigo,
        deviceId: obterDeviceId(), nome: obterNomeDispositivo(),
    });
    if (!enviado) aviso("O servidor está desconectado. Aguarde a reconexão e tente de novo.");
}

inputs.forEach((input, index) => {
    input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(0, 1);
        if (input.value && index < inputs.length - 1) inputs[index + 1].focus();
        enviarCodigoSeCompleto();
    });

    input.addEventListener("keydown", event => {
        if (event.key === "Backspace" && input.value === "" && index > 0) {
            inputs[index - 1].focus();
        }
    });

    input.addEventListener("paste", event => {
        const clipboardData = event.clipboardData;
        if (!clipboardData) return;
        const colado = clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
        if (!colado) return;
        event.preventDefault();
        limparInputs();
        colado.split("").forEach((digito, i) => { if (inputs[i]) inputs[i].value = digito; });
        const proximoFoco = Math.min(colado.length, inputs.length - 1);
        inputs[proximoFoco].focus();
        enviarCodigoSeCompleto();
    });
});

// ─── Botões principais ────────────────────────────────────────────────────────

document.getElementById("btn-tornar-servidor")?.addEventListener("click", () => {
    abrirModalAoGerar = true;
    if (!enviar({ type: "tornar-servidor", deviceId: obterDeviceId(), nome: obterNomeDispositivo() })) {
        abrirModalAoGerar = false;
        aviso("Servidor desconectado. Aguarde a reconexão.");
        return;
    }
    souServidor = true;
    telaDeCodigo?.classList.remove("active");
});

function pararServidor() {
    souServidor = false;
    meuCodigoServidor = null;
    pararContagem();
    mostrarDigitos("");
    telaDeCodigo?.classList.remove("active");

    filaPedidos.length = 0;
    fecharDialogoPedido();

    enviar({ type: "parar-servidor" });

    const idsServidor = [...sessoes.entries()]
        .filter(([, s]) => s.papel === "servidor")
        .map(([id]) => id);
    for (const id of idsServidor) encerrarSessao(id);
}

document.getElementById("btn-conectar")?.addEventListener("click", abrirModalConectar);
document.getElementById("btn-conectar-extra")?.addEventListener("click", abrirModalConectar);

fecharModalConectar?.addEventListener("click", () => {
    telaDeConectar?.classList.remove("active");
    limparInputs();
});

fecharModal?.addEventListener("click", () => {
    telaDeCodigo?.classList.remove("active");
});

// ─── Mensagens do servidor WebSocket ─────────────────────────────────────────

/**
 * @param {{ data: string; }} event
 */
function tratarMensagem(event) {
    let dados;
    try {
        dados = JSON.parse(event.data);
    } catch {
        console.error("Mensagem inválida do servidor:", event.data);
        return;
    }
    if (!dados || typeof dados !== "object") return;

    switch (dados.type) {

        case "identidade-autenticada": {
            if (dados.authToken && !salvarTokenAutenticacao(dados.authToken)) {
                bloqueioIdentidade = true;
                aviso("Não foi possível salvar a credencial deste dispositivo. Habilite o armazenamento local do navegador e abra o Physical Cloud novamente.");
                socket?.close(4004, "Credencial não pôde ser salva");
                break;
            }
            if (!obterTokenAutenticacao()) {
                bloqueioIdentidade = true;
                aviso("A credencial deste dispositivo não está disponível no armazenamento local. Não use navegação anônima nem limpe os dados do site.");
                socket?.close(4004, "Credencial ausente");
                break;
            }
            identidadeAutenticada = true;
            window.PhysicalCloudIceServers = Array.isArray(dados.turnServers) ? dados.turnServers : [];
            window.dispatchEvent(new CustomEvent("physicalcloud:ice-config-disponivel", { detail: { turnServers: window.PhysicalCloudIceServers } }));
            window.dispatchEvent(new CustomEvent("physicalcloud:websocket-aberto"));
            if (reconectando) {
                reconectando = false;
                aviso("Reconectado ao servidor.");
            }
            if (souServidor) {
                abrirModalAoGerar = true;
                enviar({ type: "tornar-servidor", deviceId: obterDeviceId(), nome: obterNomeDispositivo() });
            }
            // Só restaura sessões depois de o servidor autenticar a identidade.
            setTimeout(() => {
                try {
                    const auto = sessionStorage.getItem("physicalCloudAutoReconnect");
                    if (auto) {
                        const data = JSON.parse(auto);
                        if (data.deviceIdAlvo) {
                            aviso("Restaurando conexão...");
                            enviar({
                                type: "reconectar-silencioso",
                                deviceId: obterDeviceId(),
                                deviceIdAlvo: data.deviceIdAlvo,
                                nome: obterNomeDispositivo()
                            });
                        }
                    }
                } catch {}
            }, 1000);
            break;
        }

        case "identidade-recusada":
            identidadeAutenticada = false;
            bloqueioIdentidade = true;
            aviso(dados.mensagem || "O servidor não reconheceu a credencial deste dispositivo. Consulte as instruções de recuperação no pacote.");
            socket?.close(4003, "Identidade não autenticada");
            break;

        case "identidade-indisponivel":
            identidadeAutenticada = false;
            aviso(dados.mensagem || "Não foi possível verificar a identidade no servidor. Tentando novamente.");
            socket?.close(1011, "Verificação de identidade indisponível");
            break;

        case "codigo-gerado":
            if (!souServidor) return;
            meuCodigoServidor = String(dados.codigo);
            if (codigoTexto) codigoTexto.textContent = meuCodigoServidor;
            mostrarDigitos(meuCodigoServidor);
            prepararExtrasDoModalCodigo();
            iniciarContagem(Number(dados.validadeSegundos) || 300);
            if (abrirModalAoGerar) telaDeCodigo?.classList.add("active");
            abrirModalAoGerar = false;
            break;

        case "codigo-expirado":
            if (!souServidor) return;
            meuCodigoServidor = null;
            pararContagem();
            mostrarDigitos("");
            if (elContagem) elContagem.textContent = "Código expirado. Gere um novo.";
            aviso("Seu código expirou. Gere um novo para aceitar outros dispositivos.");
            break;

        case "servidor-parado":
            break;

        case "aguardando-aprovacao":
            aguardandoAprovacao = true;
            sessaoAguardando = String(dados.sessaoId);
            if (dados.via === "id-automatico") {
                // Notifica o modal de conectar-por-id que o dispositivo foi encontrado
                window.dispatchEvent(new CustomEvent("physicalcloud:conectar-por-id-encontrado", {
                    detail: { sessaoId: dados.sessaoId }
                }));
            } else {
                aviso(dados.via === "reconexao" ? "Reconectando... aguarde aprovação." : "Pedido enviado. Aguarde o outro dispositivo aprovar…");
            }
            break;

        case "pedido-conexao": {
            const sessaoId = String(dados.sessaoId || "");
            if (!sessaoId || filaPedidos.some(p => p.sessaoId === sessaoId)) break;
            const agora = Date.now();
            const expiraEm = Number.isSafeInteger(Number(dados.expiraEm))
                ? Number(dados.expiraEm) : agora + Math.max(1000, Number(dados.validadeMs) || TEMPO_PEDIDO_S * 1000);
            if (expiraEm <= agora) break;
            filaPedidos.push({
                sessaoId,
                nome: String(dados.nome || "Dispositivo"),
                chegouEm: agora,
                expiraEm,
                via: String(dados.via || "codigo"),
            });
            mostrarProximoPedido();
            break;
        }

                case "conectado": {
                        try {
        const peerId = dados.servidorDeviceId || dados.clienteDeviceId;
        if (peerId) {
            sessionStorage.setItem("physicalCloudAutoReconnect", JSON.stringify({ deviceIdAlvo: peerId }));
        }
    } catch {}
            aguardandoAprovacao = false;
            sessaoAguardando = null;
            const permissao = String(dados.permissao || "leitura");
            const sessaoId = String(dados.sessaoId);
            const nomeServidor = String(dados.servidorNome || "Dispositivo servidor");
            const deviceIdServidor = dados.servidorDeviceId;

            const alias = obterAlias(deviceIdServidor);
            sessoes.set(sessaoId, { papel: "cliente", nome: alias || nomeServidor, permissao, deviceId: deviceIdServidor });
            
            if (deviceIdServidor) {
                salvarDispositivoConhecido(deviceIdServidor, alias || nomeServidor, "servidor");
            }

            telaDeConectar?.classList.remove("active");
            limparInputs();
            // @ts-ignore
            aviso(`${dados.mensagem || "Conexão estabelecida com sucesso!"} (${TEXTO_PERMISSAO[permissao] || permissao})`);
            atualizarListaDispositivos();
            window.dispatchEvent(new CustomEvent("physicalcloud:sessao-ativa", { detail: { sessaoId, papel: "cliente" } }));
            break;
        }

                case "dispositivo-conectou": {
                        try {
        const peerId = dados.servidorDeviceId || dados.clienteDeviceId;
        if (peerId) {
            sessionStorage.setItem("physicalCloudAutoReconnect", JSON.stringify({ deviceIdAlvo: peerId }));
        }
    } catch {}
            const sessaoId = String(dados.sessaoId);
             souServidor = true;
            const permissao = String(dados.permissao || "leitura");
            const nome = String(dados.nome || "Dispositivo");
            const deviceIdCliente = dados.clienteDeviceId;

            const alias = obterAlias(deviceIdCliente);
            sessoes.set(sessaoId, { papel: "servidor", nome: alias || nome, permissao, deviceId: deviceIdCliente });

            if (deviceIdCliente) {
                salvarDispositivoConhecido(deviceIdCliente, alias || nome, "cliente");
            }

            // @ts-ignore
            aviso(`${alias || nome} conectou ao seu dispositivo (${TEXTO_PERMISSAO[permissao] || permissao}).`);
            atualizarListaDispositivos();
            window.dispatchEvent(new CustomEvent("physicalcloud:sessao-ativa", { detail: { sessaoId, papel: "servidor" } }));
            break;
        }

        case "sessao-nome-atualizado": {
            const id = String(dados.sessaoId);
            const s = sessoes.get(id);
            if (s) {
                s.nome = String(dados.nome);
                atualizarListaDispositivos();
            }
            break;
        }

        case "sessao-encerrada": {
            const id = String(dados.sessaoId);

            if (dados.motivo === 'dispositivo-desconectou') {
                // Espera 4 segundos antes de remover da tela, dando tempo para o auto-reconnect
                setTimeout(() => {
                    if (sessoes.has(id)) {
                        const existia = sessoes.delete(id);
                        if (existia) {
                            aviso("A conexão foi encerrada.");
                            atualizarListaDispositivos();
                            window.dispatchEvent(new CustomEvent("physicalcloud:sessao-encerrada", { detail: { sessaoId: id } }));
                        }
                    }
                }, 4000);
                return; 
            }
            removerPedido(id);
            const existia = sessoes.delete(id);
            const eraMeuPedido = id === sessaoAguardando;
            if (eraMeuPedido) {
                aguardandoAprovacao = false;
                sessaoAguardando = null;
                limparInputs();
                inputs[0]?.focus();
            }
            if (existia || eraMeuPedido) {
                aviso(MOTIVOS_ENCERRAMENTO[/** @type {keyof typeof MOTIVOS_ENCERRAMENTO} */ (dados.motivo)] || "A conexão foi encerrada.");
            }
            atualizarListaDispositivos();
            if (existia) {
                window.dispatchEvent(new CustomEvent("physicalcloud:sessao-encerrada", { detail: { sessaoId: id } }));
            }
            break;
        }

        case "sinal":
            window.dispatchEvent(new CustomEvent("physicalcloud:sinal", { detail: dados }));
            break;

        case "erro":
            // Erros correlacionados por requestId pertencem a uma operação do
            // modo automático (registro/revogação). Não podem limpar o estado
            // de uma conexão normal que esteja aguardando aprovação.
            if (typeof dados.requestId === "string" && dados.requestId.length >= 8) {
                window.dispatchEvent(new CustomEvent("physicalcloud:mensagem-recebida", { detail: dados }));
                break;
            }
            aguardandoAprovacao = false;
            sessaoAguardando = null;
            aviso(dados.mensagem || "Não foi possível conectar.");
            limparInputs();
            inputs[0]?.focus();
            break;

        case "conectar-por-id-nao-encontrado":
            window.dispatchEvent(new CustomEvent("physicalcloud:conectar-por-id-erro", { detail: dados }));
            aguardandoAprovacao = false;
            sessaoAguardando = null;
            break;

        case "pedido-automatico":
        case "registrar-id-automatico-ok":
        case "desregistrar-id-automatico-ok":
            window.dispatchEvent(new CustomEvent("physicalcloud:mensagem-recebida", { detail: dados }));
            break;

        default:
            console.log("Mensagem não tratada:", dados);
    }
}

// ─── Conexão WebSocket ────────────────────────────────────────────────────────

function conectarSocket() {
    if (bloqueioIdentidade) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (timerReconexao) clearTimeout(timerReconexao);
    timerReconexao = null;

    const ws = new WebSocket(URL_SERVIDOR);
    socket = ws;

    ws.addEventListener("open", () => {
        tentativasReconexao = 0;
        identidadeAutenticada = false;
        if (!verificarArmazenamentoAutenticacao()) {
            bloqueioIdentidade = true;
            aviso("O armazenamento local está bloqueado. Ative o armazenamento do site/app para registrar a credencial segura deste dispositivo.");
            ws.close(4004, "Armazenamento local indisponível");
            return;
        }
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 240000);
        enviar({
            type: "identificar",
            deviceId: obterDeviceId(),
            nome: obterNomeDispositivo(),
            authVersion: 1,
            authToken: obterTokenAutenticacao()
        });
    });

    ws.addEventListener("message", tratarMensagem);
    ws.addEventListener("error", () => console.error("Erro no WebSocket."));

    ws.addEventListener("close", event => {
        if (socket !== ws) return;
        identidadeAutenticada = false;
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = null;

        meuCodigoServidor = null;
        pararContagem();
        mostrarDigitos("");
        telaDeCodigo?.classList.remove("active");

        for (const sessaoId of [...sessoes.keys()]) {
            window.dispatchEvent(new CustomEvent("physicalcloud:sessao-encerrada", { detail: { sessaoId } }));
        }
        sessoes.clear();
        atualizarListaDispositivos();

        filaPedidos.length = 0;
        fecharDialogoPedido();
        aguardandoAprovacao = false;
        sessaoAguardando = null;

        if (event.code === 4003 || event.code === 4004 || bloqueioIdentidade) return;
        const recusado = event.code === 1008;
        const espera = recusado ? 30000 : Math.min(1000 * 2 ** tentativasReconexao, 15000);
        if (tentativasReconexao === 0 || recusado) {
            aviso(recusado
                ? `O servidor recusou a conexão${event.reason ? ": " + event.reason : ""}.`
                : "Conexão perdida. Tentando reconectar…");
        }
        tentativasReconexao++;
        reconectando = true;
        timerReconexao = setTimeout(conectarSocket, espera);
    });
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    if (timerReconexao) clearTimeout(timerReconexao);
    tentativasReconexao = 0;
    conectarSocket();
});

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * @param {string} sessaoId
 */
function encerrarSessao(sessaoId) {
        try { sessionStorage.removeItem("physicalCloudAutoReconnect"); } catch {}
    enviar({ type: "encerrar", sessaoId });
    const existia = sessoes.delete(sessaoId);
    atualizarListaDispositivos();
    if (existia) {
        window.dispatchEvent(new CustomEvent("physicalcloud:sessao-encerrada", { detail: { sessaoId } }));
    }
}

window.addEventListener("physicalcloud:aviso", (event) => {
    const mensagem = /** @type {CustomEvent} */ (event).detail?.mensagem;
    if (typeof mensagem === "string" && mensagem) aviso(mensagem);
});

window.addEventListener("physicalcloud:aviso-local", (event) => {
    const { sessaoId, motivo } = /** @type {CustomEvent} */ (event).detail;
    const s = sessaoId ? sessoes.get(String(sessaoId)) : undefined;
    const nome = s?.nome || "Dispositivo";

    if (motivo === "conexao-perdida") {
        aviso(`A conexão com ${nome} foi perdida.`);
    } else if (motivo === "conexao-nao-estabelecida") {
        aviso(`Não foi possível conectar diretamente com ${nome}. Verifique firewalls ou tente outra rede.`);
    } else if (motivo === "relay-detectado") {
        aviso(`Conexão com ${nome} está sendo retransmitida. Pode ser mais lenta que o normal.`);
    }
});

/** @type {any} */ (window).PhysicalCloud = { 
    enviar, sessoes, obterDeviceId, encerrarSessao, aviso, 
    obterNomeDispositivo, atualizarListaDispositivos, salvarAlias,
    isSocketOpen: () => !!socket && socket.readyState === WebSocket.OPEN,
    isAuthenticated: () => !!identidadeAutenticada
};

conectarSocket();
atualizarListaDispositivos(); // Isso faz a lista de conhecidos aparecer assim que a página abre!