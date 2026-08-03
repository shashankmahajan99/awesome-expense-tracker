import Foundation
import SwiftData
import SwiftUI
import UIKit

@Model
final class PaisaTransaction {
    @Attribute(.unique) var id: UUID
    var merchant: String
    var amount: Double
    var occurredAt: Date
    var timeVerified: Bool = false
    var category: String
    var note: String
    var reviewStatus: String
    var source: String
    var accountTag: String = ""
    var updatedAt: Date = Date.now
    var isDeleted: Bool = false

    init(id: UUID = UUID(), merchant: String, amount: Double, occurredAt: Date = .now, timeVerified: Bool = true, category: String = "Uncategorised", note: String = "", reviewStatus: String = "unresolved", source: String = "manual", accountTag: String = "", updatedAt: Date = .now, isDeleted: Bool = false) {
        self.id = id; self.merchant = merchant; self.amount = amount; self.occurredAt = occurredAt
        self.timeVerified = timeVerified; self.category = category; self.note = note; self.reviewStatus = reviewStatus; self.source = source; self.accountTag = accountTag; self.updatedAt = updatedAt; self.isDeleted = isDeleted
    }
}

@Model
final class PaymentAccount {
    @Attribute(.unique) var id: UUID
    var name: String
    var kind: String
    var institution: String
    var lastFour: String
    var aliasesJSON: String
    var updatedAt: Date

    init(id: UUID = UUID(), name: String, kind: String = "bank", institution: String = "", lastFour: String = "", aliases: [String] = [], updatedAt: Date = .now) {
        self.id = id; self.name = name; self.kind = kind; self.institution = institution; self.lastFour = String(lastFour.filter(\.isNumber).suffix(4)); self.aliasesJSON = (try? String(data: JSONEncoder().encode(aliases), encoding: .utf8)) ?? "[]"; self.updatedAt = updatedAt
    }
    var aliases: [String] { (try? JSONDecoder().decode([String].self, from: Data(aliasesJSON.utf8))) ?? [] }
    var displayName: String { lastFour.isEmpty ? name : "\(name) · •••• \(lastFour)" }
}

enum PaisaTheme {
    private static func adaptive(light: UIColor, dark: UIColor) -> Color { Color(UIColor { $0.userInterfaceStyle == .dark ? dark : light }) }
    static let canvas = adaptive(light: UIColor(red: 246 / 255, green: 243 / 255, blue: 236 / 255, alpha: 1), dark: UIColor(red: 16 / 255, green: 24 / 255, blue: 21 / 255, alpha: 1))
    static let surface = adaptive(light: UIColor(red: 252 / 255, green: 250 / 255, blue: 245 / 255, alpha: 1), dark: UIColor(red: 23 / 255, green: 35 / 255, blue: 31 / 255, alpha: 1))
    static let forest = Color(red: 23 / 255, green: 61 / 255, blue: 53 / 255)
    static let forestSoft = Color(red: 47 / 255, green: 83 / 255, blue: 74 / 255)
    static let ink = adaptive(light: UIColor(red: 24 / 255, green: 35 / 255, blue: 31 / 255, alpha: 1), dark: UIColor(red: 237 / 255, green: 243 / 255, blue: 239 / 255, alpha: 1))
    static let muted = adaptive(light: UIColor(red: 103 / 255, green: 110 / 255, blue: 103 / 255, alpha: 1), dark: UIColor(red: 174 / 255, green: 187 / 255, blue: 180 / 255, alpha: 1))
    static let gold = Color(red: 229 / 255, green: 194 / 255, blue: 111 / 255)
    static let peach = Color(red: 230 / 255, green: 174 / 255, blue: 126 / 255)
    static let line = adaptive(light: UIColor(red: 219 / 255, green: 216 / 255, blue: 207 / 255, alpha: 1), dark: UIColor(red: 52 / 255, green: 68 / 255, blue: 61 / 255, alpha: 1))
}

struct PaisaCard<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PaisaTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(PaisaTheme.line.opacity(0.8)))
    }
}

struct PaisaEyebrow: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .bold, design: .rounded))
            .tracking(1.6)
            .foregroundStyle(PaisaTheme.muted)
    }
}

enum PaisaFormat {
    static let money: NumberFormatter = {
        let value = NumberFormatter(); value.numberStyle = .currency; value.currencyCode = "INR"; value.maximumFractionDigits = 0; value.locale = Locale(identifier: "en_IN"); return value
    }()
    static func amount(_ value: Double) -> String { money.string(from: NSNumber(value: value)) ?? "₹0" }
    static func transactionDate(_ date: Date, timeVerified: Bool) -> String { timeVerified ? date.formatted(.dateTime.day().month().year().hour().minute()) : date.formatted(.dateTime.day().month().year()) }
}

enum PaisaDateWindow: String, CaseIterable, Identifiable {
    case all = "All time", seven = "Last 7 days", thirty = "Last 30 days", ninety = "Last 90 days", month = "This month", year = "This year", custom = "Custom dates"
    var id: String { rawValue }
    func contains(_ date: Date, customFrom: Date = .distantPast, customTo: Date = .distantFuture, now: Date = .now, calendar: Calendar = .current) -> Bool {
        guard self != .all else { return true }
        if self == .custom {
            let lower = calendar.startOfDay(for: min(customFrom, customTo))
            let upper = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: max(customFrom, customTo))) ?? max(customFrom, customTo)
            return date >= lower && date < upper
        }
        let start: Date?
        switch self {
        case .seven: start = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: now))
        case .thirty: start = calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: now))
        case .ninety: start = calendar.date(byAdding: .day, value: -89, to: calendar.startOfDay(for: now))
        case .month: start = calendar.date(from: calendar.dateComponents([.year, .month], from: now))
        case .year: start = calendar.date(from: calendar.dateComponents([.year], from: now))
        case .all, .custom: start = nil
        }
        return start.map { date >= $0 && date <= now } ?? true
    }
}

struct PaisaDateWindowPicker: View {
    @Binding var selection: PaisaDateWindow
    @Binding var customFrom: Date
    @Binding var customTo: Date
    var title: String = "Activity period"
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(title, systemImage: "calendar").font(.subheadline.weight(.semibold)).foregroundStyle(PaisaTheme.ink)
                Spacer()
                Picker("Period", selection: $selection) { ForEach(PaisaDateWindow.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.menu)
            }
            if selection == .custom {
                HStack(spacing: 14) {
                    dateField("From", value: $customFrom)
                    dateField("To", value: $customTo)
                }
            }
        }
        .padding(12)
        .background(PaisaTheme.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(PaisaTheme.line.opacity(0.8)))
    }
    private func dateField(_ title: String, value: Binding<Date>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased()).font(.system(size: 9, weight: .bold, design: .rounded)).tracking(1).foregroundStyle(PaisaTheme.muted)
            DatePicker(title, selection: value, displayedComponents: .date).labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
