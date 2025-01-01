#!/usr/bin/env gjs-console

const { Gio, GLib } = imports.gi;

// import GLib from 'gi://GLib';
// import Gio from 'gi://Gio';

const BLUEZ_BUS_NAME = 'org.bluez';
const BLUEZ_ROOT_PATH = '/';

const BLUEZ_DEVICE = 'org.bluez.Device1';
const BLUEZ_GATT_SERVICE = 'org.bluez.GattService1'
const BLUEZ_GATT_CHARACTERISCITC = 'org.bluez.GattCharacteristic1'
const BLUEZ_GATT_DESCRIPTOR = 'org.bluez.GattDescriptor1'

const UUID_SERVICE_BATTERY = "0000180f-0000-1000-8000-00805f9b34fb"
const UUID_CHAR_BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb"
// Characteristic Presentation Format
const UUID_CHAR_PRESENTATION_FORMAT = "00002904-0000-1000-8000-00805f9b34fb"
// Characteristic User Description
const UUID_CHAR_USER_DESC = "00002901-0000-1000-8000-00805f9b34fb"

const bus = Gio.DBus.system;

function getManagedObjects() {
    const objManager = Gio.DBusProxy.new_sync(
        bus,
        Gio.DBusProxyFlags.NONE,
        null,
        BLUEZ_BUS_NAME,
        BLUEZ_ROOT_PATH,
        'org.freedesktop.DBus.ObjectManager',
        null,
    );

    let result = objManager.call_sync(
        'GetManagedObjects',
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
    );

    return result.get_child_value(0).deepUnpack();
}

/**
 * Searches for devices with battery service.
 *
 * @param {Object} managedObjects - The managed objects containing device information.
 * @returns {Array<string>} - An array of object paths for devices with battery service.
 */
function searchDevicesWithBatteryService(managedObjects) {
    let devices = new Set();

    for (let [objectPath, interfaces] of Object.entries(managedObjects)) {
        if (BLUEZ_GATT_SERVICE in interfaces) {
            let service = interfaces[BLUEZ_GATT_SERVICE];
            let uuid = service['UUID'].deepUnpack();
            if (uuid === UUID_SERVICE_BATTERY) {
                const devicePath = service['Device'].deepUnpack();
                // print(`Found device: ${devicePath}`);
                // example: /org/bluez/hci0/dev_XX_XX_XX_XX_XX_XX
                devices.add(devicePath);
            }
        }
    }

    return [...devices];
}

/**
 * Calls the ReadValue method on a characteristic or descriptor to read its value.
 * @param {string} path - The path of the characteristic or descriptor.
 * @param {string} interface - Either org.bluez.GattCharacteristic1 or org.bluez.GattDescriptor1.
 * @returns {Uint8Array} - The value.
 */
function readBluetoothValue(path, interface) {
    const callResult = bus.call_sync(
        BLUEZ_BUS_NAME,
        path,
        interface,
        'ReadValue',
        new GLib.Variant('(a{sv})', [{}]),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null
    );

    const byteArray = callResult.get_child_value(0).deepUnpack();
    return byteArray
}

function listBatteryLevels(managedObjects, devicePath) {
    // We are looping through the managed objects multiple times and
    // the algorithm can be optimized, but unless we have a large number
    // of devices it should be fine. I'm keeping it simple for now.
    const gattServicePath = [];

    // Find GATT caracteristics for battery level.
    for (let [objectPath, interfaces] of Object.entries(managedObjects)) {
        if (objectPath.startsWith(devicePath) && BLUEZ_GATT_CHARACTERISCITC in interfaces) {
            let characteristic = interfaces[BLUEZ_GATT_CHARACTERISCITC];
            let uuid = characteristic['UUID'].deepUnpack();
            if (uuid === UUID_CHAR_BATTERY_LEVEL) {
                // print(`Characteristic: ${characteristic['UUID'].deepUnpack()}`);
                // example: /org/bluez/hci0/dev_XX_XX_XX_XX_XX_XX/serviceXX/charXX
                gattServicePath.push(objectPath);
            }
        }
    }

    const batteryLevels = [];

    // Read battery level and user description for each battery.
    for (let servicePath of gattServicePath) {

        // result should be a single byte representing the battery percentage
        const batteryByteArray = readBluetoothValue(servicePath, BLUEZ_GATT_CHARACTERISCITC);
        const batteryPercent = batteryByteArray[0];

        let batteryLevel = {
            batteryPercent: batteryPercent,
            displayName: "Main",
            sortOrder: -1,
            userDesc: null,
            presentDesc: null
        };

        // Read Characteristic Presentation Format for battery description.
        for (let [objectPath, interfaces] of Object.entries(managedObjects)) {
            if (objectPath.startsWith(servicePath) && BLUEZ_GATT_DESCRIPTOR in interfaces) {
                let descriptor = interfaces[BLUEZ_GATT_DESCRIPTOR];
                let uuid = descriptor['UUID'].deepUnpack();
                if (uuid === UUID_CHAR_PRESENTATION_FORMAT) {
                    const byteArray = readBluetoothValue(objectPath, BLUEZ_GATT_DESCRIPTOR);
                    // print(`Presentation Format: (length: ${byteArray.length}) ${formatByteArray(byteArray)}`);

                    // byte 0: format, 0x04 for unsigned 8-bit integer
                    // byte 1: exponent, 0x00
                    // byte 2-3: unit, 0x27ad for percentage
                    // byte 4: namespace, 0x01 for Bluetooth SIG assigned numbers
                    // byte 5-6: description

                    if (byteArray.length !== 7) {
                        print(`Invalid Presentation Format: ${formatByteArray(byteArray)}`);
                        batteryLevel = null;
                        break;
                    }
                    if (byteArray[0] !== 0x04 || byteArray[1] !== 0x00 || byteArray[2] !== 0xad || byteArray[3] !== 0x27 || byteArray[4] !== 0x01) {
                        print(`Unsupported Presentation Format: ${formatByteArray(byteArray)}`);
                        batteryLevel = null;
                        break;
                    }

                    // byte 5-6 is the description
                    let cpfDesc = byteArray[5] | (byteArray[6] << 8);
                    if (cpfDesc === 0x0106) { // main
                        batteryLevel.sortOrder = -1;
                    } else {
                        batteryLevel.sortOrder = cpfDesc;
                    }
                    batteryLevel.presentDesc = cpfDescToName(cpfDesc);

                } else if (uuid === UUID_CHAR_USER_DESC) {
                    const byteArray = readBluetoothValue(objectPath, BLUEZ_GATT_DESCRIPTOR);
                    // print(`User Description: (length: ${byteArray.length}) ${decodeByteArray(byteArray)}`);
                    batteryLevel.userDesc = decodeByteArray(byteArray);
                }
            }
        }

        if (batteryLevel) { // if we have a valid battery level

            if (batteryLevel.userDesc) { // prefer user description
                batteryLevel.displayName = batteryLevel.userDesc;
            } else if (batteryLevel.presentDesc) { // fallback to presentation format
                batteryLevel.displayName = batteryLevel.presentDesc;
            }

            batteryLevels.push(batteryLevel);
        }
    }

    batteryLevels.sort((a, b) => a.sortOrder - b.sortOrder); // sort by sortOrder, which is the CPF description

    return batteryLevels;
}

// Bluetooth SIG GATT Characteristic Presentation Format Description
// https://www.bluetooth.com/wp-content/uploads/Files/Specification/Assigned_Numbers.html#bookmark46
function cpfDescToName(cpf) {
    if (cpf < 0) return 'Invalid';
    if (cpf === 0x0000) return 'Unknown';
    if (cpf <= 0x00FF) {
        const tenth = cpf % 10, moduloHundred = cpf % 100;
        if (tenth === 1 && moduloHundred !== 11) { return cpf + "st"; }
        if (tenth === 2 && moduloHundred !== 12) { return cpf + "nd"; }
        if (tenth === 3 && moduloHundred !== 13) { return cpf + "rd"; }
        return cpf + "th";
    }
    switch (cpf) {
        case 0x0100: return 'Front';
        case 0x0101: return 'Back';
        case 0x0102: return 'Top';
        case 0x0103: return 'Bottom';
        case 0x0104: return 'Upper';
        case 0x0105: return 'Lower';
        case 0x0106: return 'Main';
        case 0x0107: return 'Backup';
        case 0x0108: return 'Auxiliary';
        case 0x0109: return 'Supplementary';
        case 0x010A: return 'Flash';
        case 0x010B: return 'Inside';
        case 0x010C: return 'Outside';
        case 0x010D: return 'Left';
        case 0x010E: return 'Right';
        case 0x010F: return 'Internal';
        case 0x0110: return 'External';
        default: return 'Invalid';
    }
}

/**
 * Formats a Uint8Array into a list of byte text for display.
 * @param {Uint8Array} byteArray - The Uint8Array to format.
 * @returns {string} - The formatted string of byte text.
 */
function formatByteArray(byteArray) {
    return Array.from(byteArray).map(byte => byte.toString(16).padStart(2, '0')).join(' ');
}

/**
 * Decodes a Uint8Array into a string.
 * @param {Uint8Array} byteArray - The Uint8Array to decode.
 * @returns {string} - The decoded string.
 */
function decodeByteArray(byteArray) {
    return new TextDecoder('utf-8').decode(byteArray);
}

function main() {
    let managedObjects = getManagedObjects();
    let devicePaths = searchDevicesWithBatteryService(managedObjects);
    for (let path of devicePaths) {
        try {

            let batteryLevels = listBatteryLevels(managedObjects, path);
            print(`Device: ${path}`);
            for (let batteryLevel of batteryLevels) {
                print(`  ${batteryLevel.displayName}: ${batteryLevel.batteryPercent}%`);
                print(`      Description: ${batteryLevel.userDesc}`);
                print(`      Presentation: ${batteryLevel.presentDesc}`);
            }

        } catch (error) {
            print(`Error reading battery level for ${path}: ${error}`);
        }
    }
}

main();
