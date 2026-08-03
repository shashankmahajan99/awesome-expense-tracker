import SwiftUI
import SwiftData
import AppIntents

enum PaisaCategories {
    static let defaults = ["Food & dining", "Groceries", "Travel", "Shopping", "Bills", "Loans & EMI", "Health", "Entertainment", "Subscriptions", "Education", "Personal care", "Home", "Gifts", "Insurance", "Investments", "Taxes", "Transfers", "Work"]
    static func suggestions(from transactions: [PaisaTransaction]) -> [String] {
        Array(Set(defaults + transactions.map(\.category).filter { !$0.isEmpty && $0.localizedCaseInsensitiveCompare("Uncategorised") != .orderedSame })).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }
    static func savedValue(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Uncategorised" : value.trimmingCharacters(in: .whitespacesAndNewlines) }
}

struct PaisaCategoryField: View {
    @Binding var category: String
    let suggestions: [String]
    var body: some View {
        HStack {
            TextField("Choose or type", text: $category)
            Menu {
                ForEach(suggestions, id: \.self) { value in Button(value) { category = value } }
            } label: { Image(systemName: "chevron.down.circle.fill").foregroundStyle(PaisaTheme.forest).font(.title3) }
            .accessibilityLabel("Show category suggestions")
        }
    }
}

struct TransactionsView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }, sort: \PaisaTransaction.occurredAt, order: .reverse) private var transactions: [PaisaTransaction]
    @State private var search = ""
    @State private var editing: PaisaTransaction?
    @State private var addNew = false
    @State private var dateWindow: PaisaDateWindow = .all
    @State private var customFrom = Calendar.current.date(byAdding: .month, value: -1, to: .now) ?? .now
    @State private var customTo = Date.now
    @State private var selecting = false
    @State private var selectedIDs = Set<UUID>()
    private var filtered: [PaisaTransaction] { transactions.filter { dateWindow.contains($0.occurredAt, customFrom: customFrom, customTo: customTo) && (search.isEmpty || "\($0.merchant) \($0.category) \($0.accountTag) \($0.note)".localizedCaseInsensitiveContains(search)) } }
    var body: some View {
        List {
            Section { PaisaDateWindowPicker(selection: $dateWindow, customFrom: $customFrom, customTo: $customTo, title: "Transaction period") }
            ForEach(filtered) { item in
                HStack(spacing: 8) {
                    if selecting { Image(systemName: selectedIDs.contains(item.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(selectedIDs.contains(item.id) ? PaisaTheme.forest : PaisaTheme.muted) }
                    TransactionRow(item: item)
                    if !selecting {
                        Menu { ForEach(PaisaCategories.suggestions(from: transactions), id: \.self) { value in Button(value) { setCategory(value, for: item) } }; Divider(); Button("Edit or add category…") { editing = item } } label: { Image(systemName: "tag.circle.fill").font(.title3).foregroundStyle(PaisaTheme.forest) }.accessibilityLabel("Quickly categorise \(item.merchant)")
                    }
                }
                    .contentShape(Rectangle()).onTapGesture { if selecting { if selectedIDs.contains(item.id) { selectedIDs.remove(item.id) } else { selectedIDs.insert(item.id) } } else { editing = item } }
                    .listRowBackground(PaisaTheme.surface)
                    .listRowSeparatorTint(PaisaTheme.line)
            }
                .onDelete { offsets in offsets.map { filtered[$0] }.forEach { $0.isDeleted = true; $0.updatedAt = .now }; try? context.save(); Task { await sync.syncIfConnected(context: context) } }
        }
        .scrollContentBackground(.hidden)
        .background(PaisaTheme.canvas)
        .searchable(text: $search, prompt: "Merchant, category, or note")
        .navigationTitle("Transactions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { Button(selecting ? "Cancel" : "Select") { selecting.toggle(); if !selecting { selectedIDs.removeAll() } } }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if selecting { Button("Delete", role: .destructive) { deleteSelected() }.disabled(selectedIDs.isEmpty) }
                else { Button { addNew = true } label: { Label("Add", systemImage: "plus") } }
            }
        }
        .sheet(item: $editing) { TransactionEditor(item: $0) }
        .sheet(isPresented: $addNew) { TransactionEditor(item: nil) }
    }

    private func setCategory(_ value: String, for item: PaisaTransaction) { item.category = value; item.updatedAt = .now; try? context.save(); Task { await sync.syncIfConnected(context: context) } }
    private func deleteSelected() { transactions.filter { selectedIDs.contains($0.id) }.forEach { $0.isDeleted = true; $0.updatedAt = .now }; try? context.save(); selectedIDs.removeAll(); selecting = false; Task { await sync.syncIfConnected(context: context) } }
}

struct TransactionEditor: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var allTransactions: [PaisaTransaction]
    @Query(sort: \PaymentAccount.name) private var paymentAccounts: [PaymentAccount]
    let item: PaisaTransaction?
    @State private var merchant = ""; @State private var amount = 0.0; @State private var date = Date(); @State private var timeVerified = true; @State private var category = "Uncategorised"; @State private var accountTag = ""; @State private var note = ""; @State private var status = "unresolved"
    @State private var showDetails = false
    @State private var showAccounts = false
    @FocusState private var merchantFocused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Section("Payment") {
                    TextField("Merchant", text: $merchant).focused($merchantFocused)
                    TextField("Amount", value: $amount, format: .number).keyboardType(.decimalPad)
                    Picker("Payment account", selection: $accountTag) { Text("No payment account").tag(""); ForEach(paymentAccounts) { Text($0.displayName).tag($0.name) } }
                    Button { showAccounts = true } label: { Label(paymentAccounts.isEmpty ? "Add a bank or card" : "Manage payment accounts", systemImage: "creditcard") }
                }
                Section("Category") { PaisaCategoryField(category: $category, suggestions: PaisaCategories.suggestions(from: allTransactions)) }
                Section { DisclosureGroup("Date, status & optional details", isExpanded: $showDetails) { DatePicker("Date", selection: $date, displayedComponents: .date); Toggle("Exact time known", isOn: $timeVerified); if timeVerified { DatePicker("Time", selection: $date, displayedComponents: .hourAndMinute) }; Picker("Status", selection: $status) { Text("Needs review").tag("unresolved"); Text("Explained").tag("explained"); Text("Known / repeat").tag("known"); Text("Deferred").tag("deferred") }; TextField("Context or note", text: $note, axis: .vertical) } }
            }
            .scrollContentBackground(.hidden).background(PaisaTheme.canvas)
            .navigationTitle(item == nil ? "Add transaction" : "Edit transaction")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { save() }.disabled(merchant.isEmpty || amount <= 0) } }
        }
        .sheet(isPresented: $showAccounts) { PaymentAccountManager() }
        .onChange(of: paymentAccounts.count) { _, count in if item == nil && accountTag.isEmpty && count == 1 { accountTag = paymentAccounts[0].name } }
        .onAppear { if let item { merchant = item.merchant; amount = item.amount; date = item.occurredAt; timeVerified = item.timeVerified; category = item.category.localizedCaseInsensitiveCompare("Uncategorised") == .orderedSame ? "" : item.category; accountTag = item.accountTag; note = item.note; status = item.reviewStatus; showDetails = true } else { if paymentAccounts.count == 1 { accountTag = paymentAccounts[0].name }; merchantFocused = true } }
    }
    private func save() { let savedCategory = PaisaCategories.savedValue(category); if let item { item.merchant = merchant; item.amount = amount; item.occurredAt = date; item.timeVerified = timeVerified; item.category = savedCategory; item.accountTag = accountTag; item.note = note; item.reviewStatus = status; item.updatedAt = .now } else { context.insert(PaisaTransaction(merchant: merchant, amount: amount, occurredAt: date, timeVerified: timeVerified, category: savedCategory, note: note, reviewStatus: status, accountTag: accountTag)) }; try? context.save(); Task { await sync.syncIfConnected(context: context) }; dismiss() }
}

struct InsightsView: View {
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var transactions: [PaisaTransaction]
    @Query(sort: \PaymentAccount.name) private var paymentAccounts: [PaymentAccount]
    @State private var dateWindow: PaisaDateWindow = .all
    @State private var customFrom = Calendar.current.date(byAdding: .month, value: -1, to: .now) ?? .now
    @State private var customTo = Date.now
    private var visible: [PaisaTransaction] { transactions.filter { dateWindow.contains($0.occurredAt, customFrom: customFrom, customTo: customTo) } }
    private var total: Double { visible.reduce(0) { $0 + $1.amount } }
    private var categorySpend: [CategorySpend] {
        Dictionary(grouping: visible, by: \.category).map { category, items in
            CategorySpend(category: category, amount: items.reduce(0) { $0 + $1.amount }, count: items.count)
        }.sorted { $0.amount > $1.amount }
    }
    private var accountSpend: [AccountSpend] {
        Dictionary(grouping: visible.filter { !$0.accountTag.isEmpty }, by: \.accountTag).map { name, items in
            let account = paymentAccounts.first { $0.name.localizedCaseInsensitiveCompare(name) == .orderedSame }
            return AccountSpend(name: account?.displayName ?? name, kind: account?.kind.capitalized ?? "Payment account", amount: items.reduce(0) { $0 + $1.amount }, count: items.count)
        }.sorted { $0.amount > $1.amount }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                PaisaEyebrow(text: "Spending snapshot")
                PaisaDateWindowPicker(selection: $dateWindow, customFrom: $customFrom, customTo: $customTo, title: "Insight period")
                VStack(alignment: .leading, spacing: 8) {
                    Text("Total tracked").font(.subheadline).foregroundStyle(.white.opacity(0.7))
                    Text(PaisaFormat.amount(total)).font(.system(size: 38, weight: .bold, design: .rounded)).foregroundStyle(.white)
                    Text("Across \(visible.count) payments").font(.caption).foregroundStyle(.white.opacity(0.65))
                }.padding(22).frame(maxWidth: .infinity, alignment: .leading).background(PaisaTheme.forestDeep, in: RoundedRectangle(cornerRadius: 24))
                PaisaEyebrow(text: "Where it went").padding(.top, 8)
                ForEach(categorySpend) { summary in
                    PaisaCard {
                        HStack { Text(summary.category).fontWeight(.bold).foregroundStyle(PaisaTheme.ink); Spacer(); Text(PaisaFormat.amount(summary.amount)).fontWeight(.bold).foregroundStyle(PaisaTheme.ink) }
                        ProgressView(value: total > 0 ? summary.amount / total : 0).tint(PaisaTheme.forest).padding(.top, 8)
                        Text("\(summary.count) \(summary.count == 1 ? "payment" : "payments")").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 4)
                    }
                }
                if !accountSpend.isEmpty {
                    PaisaEyebrow(text: "By payment account").padding(.top, 8)
                    ForEach(accountSpend) { summary in
                        PaisaCard {
                            HStack { VStack(alignment: .leading, spacing: 3) { Text(summary.name).fontWeight(.bold).foregroundStyle(PaisaTheme.ink); Text(summary.kind).font(.caption).foregroundStyle(PaisaTheme.muted) }; Spacer(); Text(PaisaFormat.amount(summary.amount)).fontWeight(.bold).foregroundStyle(PaisaTheme.ink) }
                            ProgressView(value: total > 0 ? summary.amount / total : 0).tint(PaisaTheme.peach).padding(.top, 8)
                            Text("\(summary.count) \(summary.count == 1 ? "payment" : "payments")").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 4)
                        }
                    }
                }
            }.padding(18)
        }
        .background(PaisaTheme.canvas.ignoresSafeArea())
        .navigationTitle("Insights")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
    }
}

private struct CategorySpend: Identifiable {
    let category: String
    let amount: Double
    let count: Int
    var id: String { category }
}

private struct AccountSpend: Identifiable {
    let name: String
    let kind: String
    let amount: Double
    let count: Int
    var id: String { name }
}

struct SettingsView: View {
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @EnvironmentObject private var notifications: NotificationManager
    private let webURL = URL(string: "https://paisa-daily-inbox.shashankmahajan.chatgpt.site")!
    @State private var confirmDelete = false
    @State private var dataMessage = ""
    @State private var showAccountManager = false
    @State private var showPaytmSetup = false
    @State private var showShareSetup = false
    @Query(sort: \PaymentAccount.name) private var paymentAccounts: [PaymentAccount]
    @AppStorage("paisaAppearance") private var appearance = "system"
    @AppStorage("paisaCompanionConsent") private var companionConsent = false

    var body: some View {
        Form {
            Section("Appearance") { Picker("Theme", selection: $appearance) { Text("Use device setting").tag("system"); Text("Light").tag("light"); Text("Dark").tag("dark") } }
            Section("Cloud sync") {
                Label(sync.status, systemImage: sync.connected ? "checkmark.icloud" : "icloud.slash")
                if sync.connected {
                    Button("Sync now") { Task { await sync.syncIfConnected(context: context) } }.disabled(sync.isWorking)
                    if sync.isWorking && sync.syncTotal > 0 {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("\(sync.syncCompleted) completed · \(max(0, sync.syncTotal - sync.syncCompleted)) left").font(.caption).foregroundStyle(PaisaTheme.muted)
                                Spacer()
                                Button { sync.stopSync() } label: { Image(systemName: "xmark.circle.fill").font(.title3) }.buttonStyle(.plain).accessibilityLabel("Stop sync")
                            }
                            ProgressView(value: Double(sync.syncCompleted), total: Double(max(1, sync.syncTotal))).tint(PaisaTheme.forest)
                        }
                    }
                    Button("Disconnect this iPhone", role: .destructive) { Task { await sync.disconnect() } }.disabled(sync.isWorking)
                } else {
                    Button("Sign in to sync") { Task { await sync.beginPairing() } }.disabled(sync.isWorking)
                }
                if sync.isWorking && sync.syncTotal == 0 { ProgressView("Checking Paisa Inbox…") }
            }
            Section("Daily review") {
                Label(notifications.statusText, systemImage: notifications.isEnabledForPaisa ? "bell.badge.fill" : "bell.slash")
                if notifications.authorizationStatus == .denied {
                    Button("Open notification settings") { notifications.openSystemSettings() }
                } else if notifications.isEnabledForPaisa {
                    Button("Stop notifications on this iPhone", role: .destructive) {
                        let token = notifications.deviceToken; notifications.stopForPaisa()
                        Task { await sync.unregisterPushToken(token) }
                    }.disabled(notifications.isUpdating)
                } else {
                    Button("Enable daily inbox notifications") {
                        Task {
                            await notifications.requestAuthorization()
                            if let token = notifications.deviceToken { await sync.registerPushToken(token) }
                        }
                    }.disabled(notifications.isUpdating)
                }
                if notifications.isUpdating { ProgressView("Updating notification settings…") }
                Text("Paisa Inbox sends at most one reminder when meaningful payments still need context. Your preferred time and quiet hours come from the web dashboard.")
                    .font(.caption).foregroundStyle(PaisaTheme.muted)
            }
            Section("Payment accounts") {
                ForEach(paymentAccounts) { account in LabeledContent(account.displayName) { Text(account.kind.capitalized).foregroundStyle(PaisaTheme.muted) } }
                Button { showAccountManager = true } label: { Label(paymentAccounts.isEmpty ? "Add your first bank or card" : "Manage payment accounts", systemImage: "creditcard") }
                Text("Saved banks, cards, wallets, and apps become reusable choices in transactions, statements, SMS imports, and insights.").font(.caption).foregroundStyle(PaisaTheme.muted)
            }
            Section("Shortcuts & bank SMS") {
                Button { showPaytmSetup = true } label: { Label("Create Paytm capture automation", systemImage: "bolt.badge.clock") }
                Text("A guided, exact Shortcuts recipe that asks after Paytm closes and records only confirmed payments.").font(.caption).foregroundStyle(PaisaTheme.muted)
                Button { showShareSetup = true } label: { Label("Enable Share to Paisa Inbox", systemImage: "square.and.arrow.up") }
                Text("Pin Paisa Inbox in the iOS Share Sheet, then send a Paytm screenshot for private on-device extraction.").font(.caption).foregroundStyle(PaisaTheme.muted)
                Label("Add Bank SMS to Paisa Inbox", systemImage: "message.badge")
                Text("For bank alerts, create a personal Message automation, add the Paisa Inbox action, pass the message text, and choose a saved bank or card. Extraction runs locally.").font(.caption).foregroundStyle(PaisaTheme.muted)
                Text("iOS does not let apps read your SMS inbox directly. The personal automation is the permission-controlled handoff.").font(.caption).foregroundStyle(PaisaTheme.muted)
            }
            Section("Data controls") {
                Label("Statements are parsed on device", systemImage: "lock.shield")
                Label("Sync tokens stay in Keychain", systemImage: "key")
                Link("Open web dashboard", destination: webURL)
                Button("Delete all transactions", role: .destructive) { confirmDelete = true }.disabled(!sync.connected)
                if sync.isWorking { Text("Deleting will stop the active sync first, then remove data everywhere.").font(.caption).foregroundStyle(PaisaTheme.muted) }
                if !sync.connected { Text("Connect to Paisa Inbox before deleting so the same data is removed from every device.").font(.caption).foregroundStyle(PaisaTheme.muted) }
                if !dataMessage.isEmpty { Text(dataMessage).font(.caption).foregroundStyle(PaisaTheme.muted) }
            }
            Section("ChatGPT companion") { Toggle("Allow optional companion features", isOn: $companionConsent); Text("Off by default. ChatGPT is currently used only to verify your identity. Statement parsing, categories, review, sync, and insights stay in Paisa Inbox and do not send transaction data to ChatGPT.").font(.caption).foregroundStyle(PaisaTheme.muted) }
        }
        .scrollContentBackground(.hidden)
        .background(PaisaTheme.canvas)
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(PaisaTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .alert("Delete all transactions everywhere?", isPresented: $confirmDelete) {
            Button("Cancel", role: .cancel) { }
            Button("Delete everywhere", role: .destructive) { Task { do { let count = try await sync.deleteCloudTransactions(context: context); dataMessage = "Deleted \(count) transaction\(count == 1 ? "" : "s") everywhere." } catch { dataMessage = error.localizedDescription } } }
        } message: { Text("This permanently removes cloud and local transaction history. Your sign-in and preferences remain.") }
        .sheet(isPresented: $showAccountManager) { PaymentAccountManager() }
        .sheet(isPresented: $showPaytmSetup) { PaytmAutomationSetupView() }
        .sheet(isPresented: $showShareSetup) { ShareSetupView() }
    }
}

private struct PaytmAutomationSetupView: View {
    @Environment(\.dismiss) private var dismiss
    private let shortcutsURL = URL(string: "shortcuts://")!
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PaisaEyebrow(text: "Instant capture")
                    Text("Log Paytm in seconds").font(.largeTitle.bold()).foregroundStyle(PaisaTheme.ink)
                    Text("This takes about a minute. Keep this page open and return after each step.").foregroundStyle(PaisaTheme.muted)
                    PaisaCard {
                        Label("The finished automation", systemImage: "checkmark.seal.fill").fontWeight(.bold).foregroundStyle(PaisaTheme.ink)
                        Text("Paytm closes → “Was that a transaction?” → Yes → ask amount → save to Daily Inbox. No does nothing.").font(.subheadline).foregroundStyle(PaisaTheme.muted).padding(.top, 7)
                    }
                    setupStep(1, "Refresh the Paisa action", "Tap the button below once so “Log a Paytm Payment” appears in Shortcuts search.")
                    Button { PaisaShortcuts.updateAppShortcutParameters() } label: { Label("Refresh Paisa Inbox actions", systemImage: "arrow.clockwise") }.buttonStyle(.bordered).tint(PaisaTheme.forest)
                    setupStep(2, "Create an App automation", "Open Shortcuts → Automation → + → New Automation → App.")
                    setupStep(3, "Choose Paytm closing", "Tap Choose, select Paytm, tick Is Closed, select Run Immediately, turn off Notify When Run, then tap Next.")
                    setupStep(4, "Ask Yes or No", "Choose New Blank Automation → Add Action. Search “Choose from Menu”. Change the prompt to “Was that a transaction?” and name the choices Yes and No.")
                    setupStep(5, "Add Paisa only under Yes", "Inside the Yes branch, tap Add Action and search exactly “Log a Paytm Payment”. Choose the action with the Paisa Inbox icon.")
                    setupStep(6, "Make amount the tiny form", "Tap Amount in the Paisa action and choose Ask Each Time. Leave Merchant and Payment Account blank—Paisa fills the saved Paytm account and suggests the category.")
                    setupStep(7, "Save and test", "Tap Done. Open Paytm, then close it. Choose Yes, enter the amount, and confirm it appears in Paisa Inbox → Today.")
                    PaisaCard {
                        Label("No battery drain", systemImage: "battery.100percent").fontWeight(.bold).foregroundStyle(PaisaTheme.ink)
                        Text("Nothing runs in the background. iOS fires the automation once when Paytm closes, and Paisa Inbox stores the confirmed payment locally.").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 6)
                    }
                    Link(destination: shortcutsURL) { Label("Open Shortcuts — start at step 2", systemImage: "arrow.up.forward.app").frame(maxWidth: .infinity).padding(15).background(PaisaTheme.forest, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(PaisaTheme.primaryForeground).fontWeight(.bold) }
                    Text("Can’t find the Paisa action? Open Paisa Inbox once after installing the latest build, return here, tap Refresh Paisa Inbox actions, then reopen Shortcuts.").font(.caption).foregroundStyle(PaisaTheme.muted)
                }.padding(20)
            }.background(PaisaTheme.canvas.ignoresSafeArea()).navigationTitle("Paytm automation").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func setupStep(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 13) { Text("\(number)").font(.headline).frame(width: 34, height: 34).background(PaisaTheme.gold, in: Circle()).foregroundStyle(PaisaTheme.forestDeep); VStack(alignment: .leading, spacing: 4) { Text(title).fontWeight(.bold).foregroundStyle(PaisaTheme.ink); Text(detail).font(.subheadline).foregroundStyle(PaisaTheme.muted) } }
    }
}

private struct ShareSetupView: View {
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    PaisaEyebrow(text: "Paytm screenshots")
                    Text("Pin Share to Paisa Inbox").font(.largeTitle.bold()).foregroundStyle(PaisaTheme.ink)
                    Text("The extension appears inside the iOS Share Sheet. iOS may place a newly installed action under More until you pin it.").foregroundStyle(PaisaTheme.muted)
                    shareStep(1, "Open the Share Sheet", "Tap Test below. You can also open any Paytm screenshot in Photos and tap Share.")
                    ShareLink(item: "Paid ₹1 to Test Merchant via Paytm") { Label("Test the Share Sheet", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent).tint(PaisaTheme.forest)
                    shareStep(2, "Find Paisa Inbox", "Scroll the horizontal app row to the end and tap More. Search for “Share to Paisa Inbox”.")
                    shareStep(3, "Pin it", "Tap Edit, add Paisa Inbox to Favorites, then move it near the front.")
                    shareStep(4, "Share the screenshot", "Paisa reads one screenshot locally, pre-fills amount, merchant, category and payment account, and lets you verify before saving.")
                    PaisaCard {
                        Label("If it is still missing", systemImage: "wrench.and.screwdriver").fontWeight(.bold).foregroundStyle(PaisaTheme.ink)
                        Text("Install the newest Paisa Inbox build that includes the PaisaShare extension, open the main app once, then restart Photos. The app and extension must be signed by the same development team.").font(.caption).foregroundStyle(PaisaTheme.muted).padding(.top, 7)
                    }
                }.padding(20)
            }.background(PaisaTheme.canvas.ignoresSafeArea()).navigationTitle("Share extension").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func shareStep(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 13) { Text("\(number)").font(.headline).frame(width: 34, height: 34).background(PaisaTheme.gold, in: Circle()).foregroundStyle(PaisaTheme.forestDeep); VStack(alignment: .leading, spacing: 4) { Text(title).fontWeight(.bold).foregroundStyle(PaisaTheme.ink); Text(detail).font(.subheadline).foregroundStyle(PaisaTheme.muted) } }
    }
}

struct PaymentAccountManager: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject private var sync: SyncManager
    @Query(sort: \PaymentAccount.name) private var accounts: [PaymentAccount]
    @Query(filter: #Predicate<PaisaTransaction> { !$0.isDeleted }) private var transactions: [PaisaTransaction]
    @State private var name = ""; @State private var kind = "bank"; @State private var institution = ""; @State private var lastFour = ""
    @State private var editing: PaymentAccount?
    @State private var deleteError = ""
    var body: some View {
        NavigationStack { Form {
            if !accounts.isEmpty { Section("Saved") { ForEach(accounts) { account in Button { beginEditing(account) } label: { VStack(alignment: .leading) { Text(account.displayName).fontWeight(.semibold).foregroundStyle(PaisaTheme.ink); Text([account.kind.capitalized, account.institution].filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(PaisaTheme.muted) } }.swipeActions { Button("Delete", role: .destructive) { remove(account) } } } } }
            Section(editing == nil ? "New payment method" : "Edit payment method") { TextField("Name", text: $name, prompt: Text("ICICI Salary Account")); Picker("Type", selection: $kind) { Text("Bank account").tag("bank"); Text("Credit / debit card").tag("card"); Text("Wallet").tag("wallet"); Text("Payment app").tag("app"); Text("Cash").tag("cash"); Text("Other").tag("other") }; TextField("Institution", text: $institution, prompt: Text("ICICI")); TextField("Last four (optional)", text: $lastFour).keyboardType(.numberPad); if !deleteError.isEmpty { Text(deleteError).font(.caption).foregroundStyle(.red) }; Button(editing == nil ? "Add payment method" : "Save changes") { save() }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty); if editing != nil { Button("Cancel editing") { reset() } } }
        }.navigationTitle("Payment accounts").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } } }
    }
    private func beginEditing(_ account: PaymentAccount) { editing = account; name = account.name; kind = account.kind; institution = account.institution; lastFour = account.lastFour; deleteError = "" }
    private func reset() { editing = nil; name = ""; kind = "bank"; institution = ""; lastFour = ""; deleteError = "" }
    private func publish() { let saved = (try? context.fetch(FetchDescriptor<PaymentAccount>())) ?? []; SharedPaymentAccountDirectory.save(saved.map { SharedPaymentAccount(id: $0.id, name: $0.name, kind: $0.kind, institution: $0.institution, lastFour: $0.lastFour) }); Task { await sync.syncIfConnected(context: context) } }
    private func save() {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let account = editing {
            let previous = account.name
            account.name = cleanName; account.kind = kind; account.institution = institution.trimmingCharacters(in: .whitespacesAndNewlines)
            account.lastFour = String(lastFour.filter(\.isNumber).suffix(4)); account.updatedAt = .now
            transactions.filter { $0.accountTag == previous }.forEach { $0.accountTag = cleanName; $0.updatedAt = .now }
        } else { context.insert(PaymentAccount(name: cleanName, kind: kind, institution: institution.trimmingCharacters(in: .whitespacesAndNewlines), lastFour: lastFour)) }
        try? context.save(); publish(); reset()
    }
    private func remove(_ account: PaymentAccount) {
        guard !transactions.contains(where: { $0.accountTag == account.name }) else { deleteError = "Move transactions to another payment method before deleting \(account.name)."; return }
        context.delete(account); try? context.save(); publish(); if editing?.id == account.id { reset() }
    }
}
