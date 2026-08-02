# Paisa for iOS

Native SwiftUI companion for the Paisa daily financial inbox. It supports local-first transactions, daily review, speech input with an explicit stop state, editing/deleting, insights, and on-device PDF/CSV statement extraction.

## Open and run

1. Install XcodeGen (`brew install xcodegen`) if needed.
2. From this directory run `xcodegen generate`.
3. Open `Paisa.xcodeproj`, select your signing team, and run on iOS 17 or later.

The current build stores data locally with SwiftData. Cloud sync should be enabled only after a mobile authentication endpoint is deployed; the private Sites browser session cannot be reused safely as an iOS API credential.
