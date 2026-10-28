import Capacitor
import UIKit

final class NoctisViewController: CAPBridgeViewController {
    /// Built with xtool the web assets are SwiftPM resources (Bundle.module), not at the
    /// root of the app bundle where Capacitor looks by default.
    override func instanceDescriptor() -> InstanceDescriptor {
        if Bundle.main.url(forResource: "public", withExtension: nil) == nil,
           let app = Bundle.module.url(forResource: "public", withExtension: nil) {
            return InstanceDescriptor(
                at: app,
                configuration: Bundle.module.url(forResource: "capacitor.config", withExtension: "json"),
                cordovaConfiguration: nil
            )
        }
        return super.instanceDescriptor()
    }

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NoctisPlugin())
    }
}
