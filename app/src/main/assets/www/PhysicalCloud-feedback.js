// PhysicalCloud-feedback.js
// @ts-check

const SUPABASE_URL = "https://eiafcjslezluvzuvzrya.supabase.co";
const SUPABASE_KEY = "sb_publishable_gvks3F8zU-96KKQn7SJv4w_ASEr3Y6Y";

// Inicializa o cliente Supabase (usando a variável global criada pelo CDN no HTML)
const _supabase = /** @type {{ supabase: { createClient: (url: string, key: string) => any } }} */ (/** @type {unknown} */ (window))
    .supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

document.addEventListener("DOMContentLoaded", () => {
    const btnAbrir = document.getElementById("btn-abrir-feedback");
    const modal = document.getElementById("modal-feedback");
    const btnFechar = document.getElementById("btn-fechar-feedback");
    const estrelas = /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("#star-rating .star"));
    const btnEnviar = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-enviar-feedback"));
    const statusTexto = document.getElementById("feedback-status");
    const categoriaInput = document.getElementById("feedback-categoria");
    const mensagemInput = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.getElementById("feedback-texto"));
const contadorInput = document.getElementById("feedback-contador");
if (mensagemInput && contadorInput) {
    mensagemInput.addEventListener("input", () => {
        contadorInput.textContent = `${mensagemInput.value.length} / 2000`;
    });
}
    if (!btnAbrir || !modal || !btnFechar || !btnEnviar || !statusTexto ||
        !(categoriaInput instanceof HTMLSelectElement) ||
        (!(mensagemInput instanceof HTMLInputElement) && !(mensagemInput instanceof HTMLTextAreaElement))) {
        return;
    }

    let notaAtual = 0;

    // ─── Controle do Modal ───────────────────────────────────────────────────
    btnAbrir?.addEventListener("click", () => {
        modal?.classList.add("active");
        statusTexto.style.display = "none";
    });

    btnFechar?.addEventListener("click", () => {
        modal?.classList.remove("active");
    });

    // ─── Lógica das Estrelas ─────────────────────────────────────────────────
    estrelas.forEach((estrela, index) => {
        estrela.addEventListener("click", () => {
            notaAtual = index + 1;
            estrelas.forEach((s, i) => {
                if (i < notaAtual) {
                    s.classList.add("active");
                } else {
                    s.classList.remove("active");
                }
            });
        });

        // Efeito hover (opcional, mas deixa mais bonito)
        estrela.addEventListener("mouseenter", () => {
            estrelas.forEach((s, i) => {
                if (i <= index) s.style.color = "var(--accent)";
                else s.style.color = "#444";
            });
        });

        estrela.addEventListener("mouseleave", () => {
            estrelas.forEach((s, i) => {
                if (i < notaAtual) s.style.color = "var(--accent)";
                else s.style.color = "#444";
            });
        });
    });

    // ─── Envio para o Supabase ───────────────────────────────────────────────
    btnEnviar?.addEventListener("click", async () => {
        if (notaAtual === 0) {
            alert("Por favor, selecione de 1 a 5 estrelas.");
            return;
        }

        const categoria = categoriaInput.value;
        const mensagem = mensagemInput.value.trim();
        if (mensagem.length > 2000) {
    alert(`Mensagem muito grande (${mensagem.length} caracteres). Reduza para até 2000.`);
    return;
}

        btnEnviar.disabled = true;
        btnEnviar.textContent = "Enviando...";
        statusTexto.style.display = "block";
        statusTexto.style.color = "#9a9a9a";
        statusTexto.textContent = "Enviando feedback...";

       try {
    const resposta = await fetch(
        `${SUPABASE_URL}/functions/v1/enviar-feedback`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({
                rating: notaAtual,
                categoria,
                mensagem,
            }),
        }
    );

    const dados = await resposta.json().catch(() => ({}));

    if (resposta.status === 429) {
        statusTexto.style.color = "#ffd280";
        statusTexto.textContent = dados.erro || "Limite diário atingido. Tente amanhã.";
        return;
    }

    if (!resposta.ok) {
        throw new Error(dados.erro || `Erro ${resposta.status}`);
    }

    statusTexto.style.color = "var(--accent)";
    statusTexto.textContent = dados.restantes !== undefined
        ? `Feedback enviado! (${dados.restantes} restantes hoje)`
        : "Feedback enviado com sucesso! Obrigado.";
            
            // Limpa o formulário
            mensagemInput.value = "";
            notaAtual = 0;
            estrelas.forEach(s => s.classList.remove("active"));

            setTimeout(() => {
                modal?.classList.remove("active");
                statusTexto.style.display = "none";
            }, 3000);

        } catch (err) {
            console.error("Erro ao enviar feedback:", err);
            statusTexto.style.color = "#ff6b6b";
            statusTexto.textContent = "Erro ao enviar. Tente novamente mais tarde.";
        } finally {
            btnEnviar.disabled = false;
            btnEnviar.textContent = "Enviar Feedback";
        }
    });
});