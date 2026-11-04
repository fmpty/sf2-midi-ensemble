#import <Capacitor/Capacitor.h>

CAP_PLUGIN(MidiBridgePlugin, "MidiBridge",
           CAP_PLUGIN_METHOD(getBluetoothPermissionState, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(requestBluetoothPermissions, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(getDevices, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(openAll, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(closeAll, CAPPluginReturnPromise);
           CAP_PLUGIN_METHOD(scanBle, CAPPluginReturnPromise);
)
