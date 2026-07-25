cask "discord-presence-relay" do
  version "1.2.0"
  sha256 "3a7d83639f5f5fb5f9689866c4f96405a36f26bbe92891f444d62ec93df2c134"

  url "https://github.com/YuzuZensai/Discord-RPC-Relay/releases/download/#{version}/discord-presence-relay-#{version}.dmg"
  name "Discord Presence Relay"
  desc "Mirrors Discord Rich Presence to every running Discord instance"
  homepage "https://github.com/YuzuZensai/Discord-RPC-Relay"

  auto_updates false
  depends_on macos: ">= :big_sur"

  app "Discord Presence Relay.app"

  postflight do
    system_command "/usr/bin/xattr",
                    args: ["-cr", "#{appdir}/Discord Presence Relay.app"],
                    sudo: false
  end

  zap trash: [
    "~/Library/Application Support/Discord Presence Relay",
    "~/Library/Preferences/cafe.kirameki.discord-presence-relay.plist",
    "~/Library/Saved Application State/cafe.kirameki.discord-presence-relay.savedState"
  ]

  caveats do
    <<~EOS
      #{token} is not notarized. The quarantine attribute is cleared
      automatically on install; if macOS still refuses to open it
      ("app is damaged and can't be opened"), run:
        xattr -cr "#{appdir}/Discord Presence Relay.app"
    EOS
  end
end
