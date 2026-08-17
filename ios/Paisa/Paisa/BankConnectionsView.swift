import SwiftUI
import UIKit

struct BankConnectionsView: View {
    @EnvironmentObject private var sync: SyncManager
    @State private var mobile = ""
    @State private var revokeTarget: BankConnection?

    private var hasCurrentConsent: Bool { sync.bankConnections.contains(where: \.isCurrent) }

    var body: some View {
        List {
            Section {
                Label(sync.bankStatus, systemImage: sync.bankConnections.contains(where: { $0.status == "ACTIVE" }) ? "checkmark.shield.fill" : "building.columns")
                    .foregroundStyle(PaisaTheme.ink)
                if sync.bankLoading { ProgressView("Checking consent status…") }
                Text("Bank updates are periodic, not instant. A recent payment can appear later; Paisa shows manual and SMS captures immediately and reconciles verified bank data when it arrives.")
                    .font(.caption).foregroundStyle(PaisaTheme.muted)
            }

            if sync.connected && sync.bankConnectionsConfigured && !hasCurrentConsent {
                Section("Connect with Setu AA") {
                    TextField("10-digit mobile number", text: $mobile).keyboardType(.phonePad).textContentType(.telephoneNumber)
                    Button {
                        Task { if let url = await sync.createBankConsent(mobile: mobile) { await UIApplication.shared.open(url) } }
                    } label: { Label("Review consent in Setu", systemImage: "arrow.up.forward.app") }
                    .disabled(sync.bankLoading || mobile.filter(\.isNumber).count < 10)
                    Text("You will leave Paisa to review and approve Setu’s consent. Paisa never asks for or receives your bank password, PIN, CVV, or OTP.")
                        .font(.caption).foregroundStyle(PaisaTheme.muted)
                }
            } else if !sync.connected {
                Section { Text("Sign in under Settings → Cloud sync before connecting a bank. Consent is tied to your Paisa account so it can be revoked safely from any signed-in device.").font(.caption).foregroundStyle(PaisaTheme.muted) }
            }

            ForEach(sync.bankConnections) { connection in
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack { Text(connection.provider).fontWeight(.bold); Spacer(); statusBadge(connection.status) }
                        if !connection.mobileLastFour.isEmpty { Text("Consent mobile · ••••••\(connection.mobileLastFour)").font(.subheadline) }
                        LabeledContent("Purpose", value: connection.purpose)
                        LabeledContent("Frequency", value: connection.frequency)
                        LabeledContent("Retention", value: connection.dataLife)
                        if let expiry = connection.expiresAt { LabeledContent("Consent expires", value: friendlyDate(expiry)) }
                        if let lastSync = connection.lastSyncedAt { LabeledContent("Last bank update", value: friendlyDate(lastSync)) }
                        if !connection.accounts.isEmpty {
                            ForEach(connection.accounts) { account in
                                Label([account.fipId, account.accType, account.maskedAccNumber].filter { !$0.isEmpty }.joined(separator: " · "), systemImage: "building.columns")
                                    .font(.caption).foregroundStyle(PaisaTheme.muted)
                            }
                        }
                        if !connection.lastError.isEmpty { Text(connection.lastError).font(.caption).foregroundStyle(.red) }
                    }
                    DisclosureGroup("Exactly what is requested") {
                        ForEach(connection.dataRequested, id: \.self) { Label($0, systemImage: "checkmark") }
                        Text("Only deposit-account summaries and transactions are requested for budgeting. Paisa cannot move money or initiate payments.").font(.caption).foregroundStyle(PaisaTheme.muted)
                    }
                    if !connection.consentUrl.isEmpty, let url = URL(string: connection.consentUrl) {
                        Link("Continue consent in Setu", destination: url)
                    }
                    Button("Refresh status") { Task { await sync.refreshBankConnection(connection) } }.disabled(sync.bankLoading)
                    if connection.isCurrent { Button("Revoke bank consent", role: .destructive) { revokeTarget = connection }.disabled(sync.bankLoading) }
                }
            }

            Section("Your control") {
                Label("Consent can be revoked at any time", systemImage: "hand.raised")
                Label("Paisa cannot transact on your bank account", systemImage: "lock.shield")
                Link("Privacy policy", destination: URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site/privacy")!)
                Link("Terms", destination: URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site/terms")!)
            }
        }
        .scrollContentBackground(.hidden).background(PaisaTheme.canvas)
        .navigationTitle("Bank connections").navigationBarTitleDisplayMode(.inline)
        .task { await sync.loadBankConnections() }
        .alert("Revoke this bank consent?", isPresented: Binding(get: { revokeTarget != nil }, set: { if !$0 { revokeTarget = nil } })) {
            Button("Cancel", role: .cancel) { revokeTarget = nil }
            Button("Revoke consent", role: .destructive) { if let target = revokeTarget { Task { await sync.revokeBankConnection(target); revokeTarget = nil } } }
        } message: { Text("Setu will stop sharing new bank data. Transactions already imported remain until you delete them or delete your Paisa account.") }
    }

    private func statusBadge(_ status: String) -> some View {
        Text(status.capitalized).font(.caption.bold()).padding(.horizontal, 9).padding(.vertical, 5)
            .background(status == "ACTIVE" ? PaisaTheme.forest.opacity(0.12) : PaisaTheme.gold.opacity(0.24), in: Capsule())
            .foregroundStyle(PaisaTheme.ink)
    }

    private func friendlyDate(_ value: String) -> String {
        let formatter = ISO8601DateFormatter()
        return formatter.date(from: value)?.formatted(.dateTime.day().month(.abbreviated).year().hour().minute()) ?? value
    }
}
