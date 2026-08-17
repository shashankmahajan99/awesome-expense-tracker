# Paisa for iOS

Native SwiftUI companion for the Paisa daily financial inbox. It supports local-first transactions, secure account pairing, bidirectional web sync, a Kakeibo-inspired monthly money plan, consent-based Setu Account Aggregator bank updates, daily review, speech input with an explicit stop state, editing/deleting, insights, and on-device PDF/CSV statement extraction.

## Open and run

1. Install XcodeGen (`brew install xcodegen`) if needed.
2. From this directory run `xcodegen generate`.
3. Open `Paisa.xcodeproj`, select your signing team, and run on iOS 17 or later.

Transactions and monthly plans remain available locally with SwiftData. The app pairs through the Paisa web sign-in, stores revocable mobile credentials in Keychain, and synchronizes with the authenticated Paisa account without copying the browser session to iOS.

Bank connections open Setu's hosted consent flow and return through the `paisa://setu-return` deep link. Paisa requests only deposit summaries and transactions for purpose code 102, displays refresh/retention/expiry details before consent, and supports revocation. Account deletion revokes current bank consents before deleting the account.
