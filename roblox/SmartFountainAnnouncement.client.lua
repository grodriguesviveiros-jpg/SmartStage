local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local playerGui = Players.LocalPlayer:WaitForChild("PlayerGui")
local announcementRemote = ReplicatedStorage:WaitForChild("SmartFountainAnnouncement")

local screenGui = Instance.new("ScreenGui")
screenGui.Name = "SmartFountainAnnouncements"
screenGui.ResetOnSpawn = false
screenGui.DisplayOrder = 100
screenGui.Parent = playerGui

local banner = Instance.new("Frame")
banner.Name = "Banner"
banner.AnchorPoint = Vector2.new(0.5, 0)
banner.Position = UDim2.new(0.5, 0, 0, -120)
banner.Size = UDim2.new(1, -32, 0, 96)
banner.BackgroundColor3 = Color3.fromRGB(14, 23, 39)
banner.BorderSizePixel = 0
banner.Visible = false
banner.Parent = screenGui

local sizeConstraint = Instance.new("UISizeConstraint")
sizeConstraint.MaxSize = Vector2.new(520, 96)
sizeConstraint.MinSize = Vector2.new(220, 96)
sizeConstraint.Parent = banner

local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 12)
corner.Parent = banner

local stroke = Instance.new("UIStroke")
stroke.Color = Color3.fromRGB(67, 133, 239)
stroke.Transparency = 0.35
stroke.Thickness = 1
stroke.Parent = banner

local accent = Instance.new("Frame")
accent.Size = UDim2.new(0, 3, 1, -28)
accent.Position = UDim2.fromOffset(13, 14)
accent.BackgroundColor3 = Color3.fromRGB(83, 151, 255)
accent.BorderSizePixel = 0
accent.Parent = banner

local accentCorner = Instance.new("UICorner")
accentCorner.CornerRadius = UDim.new(1, 0)
accentCorner.Parent = accent

local heading = Instance.new("TextLabel")
heading.BackgroundTransparency = 1
heading.Position = UDim2.fromOffset(29, 14)
heading.Size = UDim2.new(1, -43, 0, 17)
heading.Font = Enum.Font.GothamBold
heading.Text = "SMART FOUNTAIN STAGE  ·  AVISO"
heading.TextColor3 = Color3.fromRGB(115, 167, 255)
heading.TextSize = 10
heading.TextXAlignment = Enum.TextXAlignment.Left
heading.Parent = banner

local messageLabel = Instance.new("TextLabel")
messageLabel.BackgroundTransparency = 1
messageLabel.Position = UDim2.fromOffset(29, 35)
messageLabel.Size = UDim2.new(1, -43, 1, -46)
messageLabel.Font = Enum.Font.GothamMedium
messageLabel.TextColor3 = Color3.fromRGB(237, 243, 252)
messageLabel.TextSize = 14
messageLabel.TextWrapped = true
messageLabel.TextXAlignment = Enum.TextXAlignment.Left
messageLabel.TextYAlignment = Enum.TextYAlignment.Top
messageLabel.Parent = banner

local latestNotice = 0

announcementRemote.OnClientEvent:Connect(function(message)
	if typeof(message) ~= "string" or #message == 0 or #message > 500 then
		return
	end

	latestNotice += 1
	local noticeId = latestNotice
	messageLabel.Text = message
	banner.Visible = true
	banner.Position = UDim2.new(0.5, 0, 0, -120)
	TweenService:Create(banner, TweenInfo.new(0.3, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), {
		Position = UDim2.new(0.5, 0, 0, 18),
	}):Play()

	task.delay(8, function()
		if latestNotice ~= noticeId then
			return
		end
		local hideTween = TweenService:Create(banner, TweenInfo.new(0.25, Enum.EasingStyle.Quad, Enum.EasingDirection.In), {
			Position = UDim2.new(0.5, 0, 0, -120),
		})
		hideTween:Play()
		hideTween.Completed:Wait()
		if latestNotice == noticeId then
			banner.Visible = false
		end
	end)
end)
