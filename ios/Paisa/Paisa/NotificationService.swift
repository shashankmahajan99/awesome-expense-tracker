import Foundation
import UIKit
import UserNotifications

extension Notification.Name {
    static let paisaPushTokenChanged = Notification.Name("paisa.push-token-changed")
    static let paisaOpenReview = Notification.Name("paisa.open-review")
}

@MainActor
final class NotificationManager: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()
    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    @Published private(set) var isEnabledForPaisa = UserDefaults.standard.bool(forKey: "paisa.notifications-enabled")
    @Published private(set) var deviceToken = UserDefaults.standard.string(forKey: "paisa.push-device-token")
    private var remotePushEnabled: Bool { Bundle.main.object(forInfoDictionaryKey: "PaisaRemotePushEnabled") as? Bool == true }

    var statusText: String {
        if !isEnabledForPaisa { return authorizationStatus == .denied ? "Notifications blocked in iOS Settings" : "Notifications are off" }
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral: return "Daily inbox notifications are on"
        case .denied: return "Notifications blocked in iOS Settings"
        case .notDetermined: return "Notifications are off"
        @unknown default: return "Notification status unavailable"
        }
    }

    func configure() async {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let review = UNNotificationAction(identifier: "REVIEW_NOW", title: "Review now", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: "DAILY_REVIEW", actions: [review], intentIdentifiers: [])])
        authorizationStatus = await center.notificationSettings().authorizationStatus
        if remotePushEnabled && isEnabledForPaisa && [.authorized, .provisional, .ephemeral].contains(authorizationStatus) { UIApplication.shared.registerForRemoteNotifications() }
    }

    func requestAuthorization() async {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            authorizationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
            isEnabledForPaisa = granted
            UserDefaults.standard.set(granted, forKey: "paisa.notifications-enabled")
            if granted && remotePushEnabled { UIApplication.shared.registerForRemoteNotifications() }
        } catch { isEnabledForPaisa = false }
    }

    func stopForPaisa() {
        isEnabledForPaisa = false
        UserDefaults.standard.set(false, forKey: "paisa.notifications-enabled")
        UNUserNotificationCenter.current().setBadgeCount(0) { _ in }
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["paisa.daily-inbox"])
    }

    func scheduleDailyInbox(unresolvedCount: Int, unresolvedAmount: Double, reviewHour: Int = 21, reviewMinute: Int = 30) async {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ["paisa.daily-inbox"])
        guard isEnabledForPaisa, unresolvedCount > 0, [.authorized, .provisional, .ephemeral].contains(authorizationStatus) else { return }
        let content = UNMutableNotificationContent()
        content.title = "Your Paisa inbox is ready"
        content.body = unresolvedCount == 1
            ? "One payment needs a little context."
            : "\(unresolvedCount) payments worth \(PaisaFormat.amount(unresolvedAmount)) need a little context."
        content.sound = .default; content.badge = NSNumber(value: unresolvedCount); content.categoryIdentifier = "DAILY_REVIEW"
        var components = DateComponents(); components.hour = reviewHour; components.minute = reviewMinute
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
        try? await center.add(UNNotificationRequest(identifier: "paisa.daily-inbox", content: content, trigger: trigger))
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func receive(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        UserDefaults.standard.set(token, forKey: "paisa.push-device-token")
        NotificationCenter.default.post(name: .paisaPushTokenChanged, object: token)
    }

    func receiveRegistrationError(_ error: Error) {
        deviceToken = nil
        UserDefaults.standard.removeObject(forKey: "paisa.push-device-token")
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .badge]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        try? await center.setBadgeCount(0)
        await MainActor.run {
            NotificationCenter.default.post(name: .paisaOpenReview, object: nil)
        }
    }
}

@MainActor
final class PaisaAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationManager.shared.receive(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationManager.shared.receiveRegistrationError(error)
    }
}
