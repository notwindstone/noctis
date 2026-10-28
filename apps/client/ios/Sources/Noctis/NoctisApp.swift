import SwiftUI

@main
struct NoctisApp: App {
    var body: some Scene {
        WindowGroup {
            // The web layer draws under the status bar and home indicator and reads
            // env(safe-area-inset-*) itself, like on Android.
            WebHost()
                .ignoresSafeArea()
                .onOpenURL { NoctisPlugin.open($0) }
        }
    }
}

struct WebHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> NoctisViewController { NoctisViewController() }
    func updateUIViewController(_ controller: NoctisViewController, context: Context) {}
}
