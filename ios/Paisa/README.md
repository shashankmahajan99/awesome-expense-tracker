# Paisa for iOS

Native SwiftUI companion for the Paisa daily financial inbox. It supports local-first transactions, secure account pairing, bidirectional web sync, daily review, speech input with an explicit stop state, editing/deleting, insights, and on-device PDF/CSV statement extraction.

## Open and run

1. Install XcodeGen (`brew install xcodegen`) if needed.
2. From this directory run `xcodegen generate`.
3. Open `Paisa.xcodeproj`, select your signing team, and run on iOS 17 or later.

Transactions remain available locally with SwiftData. The app pairs through a ten-minute one-time code, stores its revocable access token in Keychain, and synchronizes with the authenticated Paisa web account without copying the browser session to iOS.
