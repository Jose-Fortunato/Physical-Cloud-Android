# Physical Cloud Android — compilar APK pelo GitHub

Este pacote esta preparado para compilar um APK DEBUG usando GitHub Actions.
Nao e necessario instalar nem abrir o Android Studio no computador para esse fluxo.

## 1. Criar o repositorio

1. Extraia este ZIP no computador.
2. No GitHub, crie um repositorio novo para o projeto Android.
3. Envie **o conteudo desta pasta** para a raiz do repositorio. A pasta `.github`
   precisa ficar diretamente na raiz do repositorio, ao lado de `app`, `build.gradle`
   e `settings.gradle`.
4. Aguarde o workflow iniciar pelo envio dos arquivos ou abra a aba **Actions**.

## 2. Gerar e baixar o APK

1. Na aba **Actions**, abra **Compilar APK Android - Physical Cloud**.
2. Clique em **Run workflow** caso a execucao automatica ainda nao tenha iniciado.
3. Abra a execucao concluida com sucesso.
4. Na secao **Artifacts**, baixe `physical-cloud-debug-apk`.
5. Extraia o ZIP do artefato. O arquivo gerado e `app-debug.apk`.
6. Copie o APK para o Android e toque nele para instalar. O Android pode pedir
   permissao para instalar aplicativos dessa origem.

## 3. O que esta configurado

- Nome exibido no Android: **Physical Cloud**.
- Identificador do pacote: `com.physicalcloud`.
- Icone: recursos adaptativos `ic_launcher` e `ic_launcher_round`, usando a arte
  do Physical Cloud que acompanha o projeto Desktop.
- Compilacao: `:app:assembleDebug`.
- Java: 17; Android SDK: 34; Gradle: 8.6.

## 4. Importante: este primeiro APK e para teste

O workflow gera um APK DEBUG instalavel para validar o app em um aparelho real.
Ele nao e ainda o pacote RELEASE assinado com uma chave permanente para distribuicao.

Como o runner do GitHub e temporario, a chave de debug pode ser diferente entre
execucoes. Se o Android disser que o app ja esta instalado mas a assinatura e
incompativel, a versao anterior precisara ser removida antes de instalar esta.
A remocao do app pode apagar dados locais; faca backup antes.

Para distribuir o APK pelo site e permitir atualizacoes sem desinstalar a versao
anterior, a proxima etapa sera criar/usar uma chave de assinatura RELEASE persistente
e guarda-la nos **GitHub Secrets**. Nunca envie o arquivo `.jks`/`.keystore` nem
senhas para um repositorio publico.

## 5. Limite desta preparacao

O workflow e os arquivos foram preparados e conferidos estaticamente neste pacote.
O build ainda precisa ser executado no GitHub Actions; nenhum APK e declarado como
gerado ou testado ate a execucao terminar com sucesso.
