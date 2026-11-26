local DataStoreService = game:GetService("DataStoreService")
local HttpService = game:GetService("HttpService")
local MessagingService = game:GetService("MessagingService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local SoundService = game:GetService("SoundService")

local DATASTORE_NAME = "SmartFountainControl"
local CONFIG_KEY = "Configuration"
local MESSAGING_TOPIC = "SmartFountainControl"

local dataStore = DataStoreService:GetDataStore(DATASTORE_NAME)
local readOptions = Instance.new("DataStoreGetOptions")
readOptions.UseCache = false

local bridge = ServerStorage:FindFirstChild("SmartFountainControl")
if not bridge then
	bridge = Instance.new("Folder")
	bridge.Name = "SmartFountainControl"
	bridge.Parent = ServerStorage
end

local function getOrCreate(className, name)
	local object = bridge:FindFirstChild(name)
	if object and object.ClassName ~= className then
		object:Destroy()
		object = nil
	end
	if not object then
		object = Instance.new(className)
		object.Name = name
		object.Parent = bridge
	end
	return object
end

local configurationLoaded = getOrCreate("BindableEvent", "ConfigurationLoaded")
local commandReceived = getOrCreate("BindableEvent", "CommandReceived")
local latestConfiguration = getOrCreate("StringValue", "LatestConfiguration")
local announcementRemote = ReplicatedStorage:FindFirstChild("SmartFountainAnnouncement")
if not announcementRemote then
	announcementRemote = Instance.new("RemoteEvent")
	announcementRemote.Name = "SmartFountainAnnouncement"
	announcementRemote.Parent = ReplicatedStorage
elseif not announcementRemote:IsA("RemoteEvent") then
	error("[SmartFountainControl] SmartFountainAnnouncement precisa ser um RemoteEvent.")
end
local configurationRemote = ReplicatedStorage:FindFirstChild("SmartFountainConfiguration")
if not configurationRemote then
	configurationRemote = Instance.new("RemoteEvent")
	configurationRemote.Name = "SmartFountainConfiguration"
	configurationRemote.Parent = ReplicatedStorage
elseif not configurationRemote:IsA("RemoteEvent") then
	error("[SmartFountainControl] SmartFountainConfiguration precisa ser um RemoteEvent.")
end

local stageMusic = SoundService:FindFirstChild("StageMusic")
if not stageMusic then
	stageMusic = Instance.new("Sound")
	stageMusic.Name = "StageMusic"
	stageMusic.Volume = 0.65
	stageMusic.Looped = true
	stageMusic.Parent = SoundService
elseif not stageMusic:IsA("Sound") then
	error("[SmartFountainControl] StageMusic precisa ser um objeto Sound no SoundService.")
end
local activeConfiguration

local function loadConfiguration()
	local success, storedValue = pcall(function()
		return dataStore:GetAsync(CONFIG_KEY, readOptions)
	end)
	if not success then
		warn("[SmartFountainControl] Não foi possível carregar o DataStore: " .. tostring(storedValue))
		return
	end
	if storedValue == nil then
		warn("[SmartFountainControl] Nenhuma configuração foi salva pelo painel ainda.")
		return
	end

	local configuration = storedValue
	if typeof(storedValue) == "string" then
		local decoded, result = pcall(function()
			return HttpService:JSONDecode(storedValue)
		end)
		if not decoded then
			warn("[SmartFountainControl] A configuração salva não contém JSON válido: " .. tostring(result))
			return
		end
		configuration = result
	end
	if typeof(configuration) ~= "table" or typeof(configuration.revision) ~= "number" then
		warn("[SmartFountainControl] O formato da configuração salva é inválido.")
		return
	end

	latestConfiguration.Value = HttpService:JSONEncode(configuration)
	activeConfiguration = configuration
	configurationLoaded:Fire(configuration)
	configurationRemote:FireAllClients(configuration)
	print("[SmartFountainControl] Configuração carregada (revisão " .. tostring(configuration.revision) .. ").")
end

local function decodeMessage(rawMessage)
	if typeof(rawMessage) ~= "string" or #rawMessage > 1024 then
		warn("[SmartFountainControl] Mensagem ignorada: formato ou tamanho inválido.")
		return nil
	end
	local success, message = pcall(function()
		return HttpService:JSONDecode(rawMessage)
	end)
	if not success or typeof(message) ~= "table" or typeof(message.action) ~= "string" then
		warn("[SmartFountainControl] Mensagem ignorada: JSON inválido.")
		return nil
	end
	return message
end

local subscribed = false
for attempt = 1, 5 do
	local success, result = pcall(function()
		return MessagingService:SubscribeAsync(MESSAGING_TOPIC, function(envelope)
			local message = decodeMessage(envelope.Data)
			if not message then
				return
			end
			print("[SmartFountainControl] Mensagem recebida: " .. message.action)
			if message.action == "notice" and typeof(message.message) == "string"
				and #message.message > 0 and #message.message <= 500 then
				commandReceived:Fire(message)
				announcementRemote:FireAllClients(message.message)
				print("[SmartFountainControl] Aviso encaminhado aos jogadores conectados.")
			elseif message.action == "music.play" and typeof(message.id) == "string"
				and string.match(message.id, "^%d+$") then
				stageMusic.SoundId = "rbxassetid://" .. message.id
				stageMusic:Play()
				commandReceived:Fire(message)
			elseif message.action == "music.pause" then
				stageMusic:Pause()
				commandReceived:Fire(message)
			elseif message.action == "music.resume" then
				stageMusic:Resume()
				commandReceived:Fire(message)
			elseif message.action == "music.stop" then
				stageMusic:Stop()
				commandReceived:Fire(message)
			elseif message.action == "music.restart" then
				stageMusic.TimePosition = 0
				stageMusic:Play()
				commandReceived:Fire(message)
			elseif message.action == "music.volume" and typeof(message.volume) == "number"
				and message.volume >= 0 and message.volume <= 1 then
				stageMusic.Volume = message.volume
				commandReceived:Fire(message)
			elseif message.action == "events.set" and typeof(message.events) == "table" then
				commandReceived:Fire(message)
				loadConfiguration()
			elseif message.action == "events.add" and typeof(message.event) == "table" then
				commandReceived:Fire(message)
				loadConfiguration()
			elseif message.action == "events.update" and typeof(message.id) == "string"
				and typeof(message.event) == "table" then
				commandReceived:Fire(message)
				loadConfiguration()
			elseif message.action == "events.remove" and typeof(message.id) == "string" then
				commandReceived:Fire(message)
				loadConfiguration()
			elseif message.action == "config.set" and typeof(message.texts) == "table" then
				commandReceived:Fire(message)
				loadConfiguration()
			else
				warn("[SmartFountainControl] Ação desconhecida ou inválida: " .. message.action)
			end
		end)
	end)
	if success then
		subscribed = true
		print("[SmartFountainControl] Inscrito no tópico " .. MESSAGING_TOPIC .. ".")
		break
	end
	warn("[SmartFountainControl] Inscrição MessagingService tentativa " .. tostring(attempt) .. " falhou: " .. tostring(result))
	task.wait(math.min(2 ^ attempt, 20))
end

Players.PlayerAdded:Connect(function(player)
	if activeConfiguration then
		configurationRemote:FireClient(player, activeConfiguration)
	end
end)

if not subscribed then
	warn("[SmartFountainControl] Não foi possível assinar o tópico. Verifique a configuração do jogo.")
end

loadConfiguration()
