#import <Capacitor/Capacitor.h>

// Register the ICloudStorage plugin with Capacitor's plugin registry.
// This Objective-C bridge is required for Capacitor to discover the Swift plugin.
CAP_PLUGIN(ICloudStoragePlugin, "ICloudStorage",
    CAP_PLUGIN_METHOD(get, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(set, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(remove, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(list, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(clear, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isAvailable, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(openFilesLocation, CAPPluginReturnPromise);
)
