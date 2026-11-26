# Smart Fountain Control

Painel web administrativo para controlar eventos, textos, música e avisos do Smart Fountain Stage. O backend usa Node.js e SQLite; as chaves da Roblox ficam somente no servidor. Não há dependências npm externas.

## 1. Rodar o painel no computador

1. Instale o Node.js 24 ou superior.
2. Copie `.env.example` para `.env`:

   ```powershell
   Copy-Item .env.example .env
   ```

3. No `.env`, configure `ADMIN_USERNAME` e `ADMIN_PASSWORD`. Não há tamanho mínimo para a senha.
4. Abra um terminal nesta pasta e rode:

   ```powershell
   npm start
   ```

5. Acesse `http://localhost:3000` e entre com o usuário e a senha configurados.

O SQLite é criado automaticamente em `data/smart-fountain.sqlite`. O arquivo `.env` e o banco local não devem ser enviados ao Git. Por padrão, o painel só aceita conexões do próprio computador. Em um serviço de hospedagem/container, configure `HOST=0.0.0.0` para permitir que o proxy do serviço alcance o processo. Não exponha o painel publicamente sem HTTPS e proteção adequada para o servidor.

## 2. Criar uma chave Roblox Open Cloud

1. Abra o [Creator Dashboard](https://create.roblox.com/dashboard/credentials?activeTab=ApiKeysTab) e crie uma API Key.
2. Limite a chave à experiência correta (Universe). Não conceda acesso a outras experiências sem necessidade.
3. Adicione somente estas permissões:
   - **Messaging Service**: `universe-messaging-service:publish`.
   - **Data Stores**: `universe-datastores.objects:read` e `universe-datastores.objects:update`. Se esta chave precisar criar o DataStore pela primeira vez, adicione também `universe-datastores.control:create`; você pode removê-la depois que o DataStore existir.
4. Copie o **Universe ID** no Creator Dashboard. É o ID da experiência, não o Place ID.
5. Cole os valores no `.env` do servidor:

   ```dotenv
   ROBLOX_API_KEY=cole-a-chave-aqui
   ROBLOX_UNIVERSE_ID=seu-universe-id
   ROBLOX_DATASTORE_NAME=SmartFountainControl
   ROBLOX_DATASTORE_ENTRY_KEY=Configuration
   ROBLOX_MESSAGING_TOPIC=SmartFountainControl
   ```

6. Pare e inicie o painel novamente com `npm start`; `.env` é lido na inicialização. Use **Testar conexão** na Visão geral. Se o DataStore ainda não tiver uma entrada, o teste informa que a Open Cloud respondeu e que a entrada será criada ao salvar a primeira configuração.

A chave nunca vai para o navegador nem para o jogo. Se aparecer erro 401/403, confirme Universe ID, chave e permissões; não cole a chave em mensagens, screenshots ou arquivos públicos.

## 3. Conectar o jogo Roblox

1. Abra a experiência correta no Roblox Studio e confirme que ela está publicada.
2. No Explorer, crie um **Script** em `ServerScriptService`.
3. Copie o conteúdo de [`roblox/SmartFountainControl.server.lua`](roblox/SmartFountainControl.server.lua) para esse Script.
4. Crie um **LocalScript** em `StarterPlayer > StarterPlayerScripts` e copie o conteúdo de [`roblox/SmartFountainAnnouncement.client.lua`](roblox/SmartFountainAnnouncement.client.lua). Ele exibe avisos recebidos em um banner para os jogadores.
5. Confira se `DATASTORE_NAME`, `CONFIG_KEY` e `MESSAGING_TOPIC` no Script de servidor são iguais aos valores do `.env`.
6. Publique a experiência uma vez com esses Scripts. Depois disso, mudar eventos e textos no painel não exige publicar uma nova versão.
7. Inicie um servidor publicado, entre no jogo e depois use o painel para salvar uma configuração ou enviar um comando.

Uma mensagem de sucesso no painel confirma somente que a Open Cloud aceitou a publicação. No Roblox Studio, abra **View > Output** e confira no servidor as mensagens `[SmartFountainControl] Inscrito no tópico ...`, `[SmartFountainControl] Mensagem recebida: notice` e `[SmartFountainControl] Aviso encaminhado aos jogadores conectados.`. Se a primeira não aparecer, verifique se o Script está em `ServerScriptService` e se a experiência publicada é a correta. Se as mensagens aparecerem mas o aviso não for exibido, confirme que o LocalScript está em `StarterPlayer > StarterPlayerScripts`.

Para testar pelo Studio, habilite **Game Settings > Security > Enable Studio Access to API Services** somente numa cópia de teste. Essa opção pode usar os mesmos DataStores da experiência publicada; não a habilite numa cópia de produção sem entender esse risco.

O Script cria em `ServerStorage` a pasta `SmartFountainControl`, com:

- `LatestConfiguration` (StringValue): JSON da última configuração recebida. Serve também para scripts que iniciem depois da carga inicial.
- `ConfigurationLoaded` (BindableEvent): dispara com a tabela da configuração no início e quando uma nova versão é publicada.
- `CommandReceived` (BindableEvent): dispara com comandos de música e avisos recebidos pelo Messaging Service.
- Em `ReplicatedStorage`, `SmartFountainConfiguration` (RemoteEvent) envia a configuração aos clientes quando ela muda e quando um jogador entra. Use-o para atualizar o menu inicial existente.
- Em `ReplicatedStorage`, `SmartFountainAnnouncement` (RemoteEvent) encaminha avisos ao LocalScript incluído.
- O Script cria ou usa `SoundService.StageMusic`. Se já existir um objeto `Sound` com esse nome, o painel o controla; caso contrário, cria um Sound para os comandos de música.

Exemplo de leitura dos textos/eventos em outro **Script de servidor**:

```lua
local HttpService = game:GetService("HttpService")
local ServerStorage = game:GetService("ServerStorage")
local bridge = ServerStorage:WaitForChild("SmartFountainControl")

local function applyConfiguration(config)
	print(config.settings.header)
	print(config.settings.subtitle)
	print(config.settings.footer)
	print(config.settings.eventsTitle)
	print(config.settings.eventsEmpty)
	print(config.settings.mainSubtitle)
	for _, event in ipairs(config.events) do
		print(event.title, event.description, event.date, event.image)
	end
end

bridge.ConfigurationLoaded.Event:Connect(applyConfiguration)
local latest = bridge:WaitForChild("LatestConfiguration")
if latest.Value ~= "" then
	applyConfiguration(HttpService:JSONDecode(latest.Value))
end
```

Para atualizar a interface existente do menu inicial com os eventos, conecte o RemoteEvent num **LocalScript** da interface:

```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local configurationRemote = ReplicatedStorage:WaitForChild("SmartFountainConfiguration")

configurationRemote.OnClientEvent:Connect(function(config)
	for _, event in ipairs(config.events) do
		print(event.title, event.description, event.date, event.image)
	end
end)
```

O Script de servidor controla música (tocar, pausar, retomar, parar, reiniciar e volume) e encaminha avisos automaticamente. O menu inicial real do Smart Fountain Stage não estava presente neste workspace; conecte o RemoteEvent acima aos componentes visuais existentes no seu jogo. Se o Sound atual tiver outro nome, renomeie-o para `StageMusic` ou ajuste essa referência no Script de servidor.

## 4. Como a sincronização funciona

- O backend grava a configuração no DataStore Open Cloud (`SmartFountainControl`, chave `Configuration`) usando atualização com criação quando a chave ainda não existe.
- O Messaging Service publica no tópico `SmartFountainControl` usando o endpoint oficial atual `POST /cloud/v2/universes/{universeId}:publishMessage`. O corpo externo contém `topic` e `message`; `message` é uma string criada com `JSON.stringify(comando)`.
- Todos os comandos publicados usam `action`: avisos (`notice`), música (`music.play`, `music.pause`, `music.resume`, `music.stop`, `music.restart`, `music.volume`), eventos (`events.set`, `events.add`, `events.update`, `events.remove`) e textos (`config.set`).
- Para eventos e textos, o backend persiste primeiro no DataStore e publica a ação correspondente; o Script relê a configuração salva e atualiza `SmartFountainConfiguration`. Música e avisos são comandos temporários.
- O painel registra administrador, data, ação e resultado localmente no histórico SQLite.

O Messaging Service confirma a aceitação da publicação, não a entrega individual a cada servidor. A API não informa quantos servidores estão ativos nem confirma qual servidor processou a mensagem; por isso o painel não inventa esse número. A comunicação exige a experiência publicada e servidores ativos inscritos no tópico.

A configuração é limitada a 32 KB para que o servidor consiga enviá-la de forma confiável aos clientes do jogo.

## 5. Endpoints e documentação oficial

- [Roblox Messaging usage guide](https://create.roblox.com/docs/cloud/guides/usage-messaging)
- [Roblox Open Cloud data stores](https://create.roblox.com/docs/cloud/guides/data-stores)
- [Permissões e gerenciamento de API Keys](https://create.roblox.com/docs/cloud/auth/api-keys)

## Verificações locais

```powershell
npm test
```

Os testes verificam validação, autenticação/CSRF, persistência SQLite e formato/encaminhamento das chamadas Open Cloud usando um transporte isolado. Para comprovar a conexão com a sua experiência real, configure a API Key e Universe ID, publique o Script Luau e use **Testar conexão** e os controles no painel.
