'use strict';

const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');
const os = require('os');
const forge = require('node-forge');
const deepClone = require('deep-clone');
const cpPromise = require('promisify-child-process');
const jwt = require('jsonwebtoken');
const { createInterface } = require('readline');
const { PassThrough } = require('stream');
const { detectPackageManager } = require('@alcalzone/pak');
const EXIT_CODES = require('./exitCodes');
const zlib = require('zlib');

// @ts-ignore
require('events').EventEmitter.prototype._maxListeners = 100;
let request;
let axios;
let extend;
let password;
let npmVersion;
let crypto;
let diskusage;
const randomID = Math.round(Math.random() * 10000000000000); // Used for creation of User-Agent
const VENDOR_FILE = '/etc/iob-vendor.json';

let lastCalculationOfIps;
let ownIpArr = [];
// Here we define all characters that are forbidden in IDs. Since we want to allow multiple
// unicode character classes, we do that by OR-ing the character classes and negating the result.
// Also, we can easily whitelist characters this way.
//
// We allow:
// · Ll = lowercase letters
// · Lu = uppercase letters
// · Nd = numbers
// · ".", "_", "-" (common in IDs)
// · "/" (required for designs)
// · " :!#$%&()+=@^{}|~" (for legacy reasons)
//
/** All characters that may not appear in an object ID. */
const FORBIDDEN_CHARS = /[^._\-/ :!#$%&()+=@^{}|~\p{Ll}\p{Lu}\p{Nd}]+/gu;

/**
 * recursively copy values from old object to new one
 *
 * @alias copyAttributes
 * @memberof tools
 * @param {object} oldObj source object
 * @param {object} newObj destination object
 * @param {object} [originalObj] optional object for read __no_change__ values
 * @param {boolean} [isNonEdit] optional indicator if copy is in nonEdit part
 *
 */
function copyAttributes(oldObj, newObj, originalObj, isNonEdit) {
    for (const attr of Object.keys(oldObj)) {
        if (
            oldObj[attr] === undefined ||
            oldObj[attr] === null ||
            typeof oldObj[attr] !== 'object' ||
            oldObj[attr] instanceof Array
        ) {
            if (oldObj[attr] === '__no_change__' && originalObj && !isNonEdit) {
                if (originalObj[attr] !== undefined) {
                    newObj[attr] = deepClone(originalObj[attr]);
                } else {
                    console.log(`Attribute ${attr} ignored by copying`);
                }
            } else if (oldObj[attr] === '__delete__' && !isNonEdit) {
                if (newObj[attr] !== undefined) {
                    delete newObj[attr];
                }
            } else {
                newObj[attr] = oldObj[attr];
            }
        } else {
            newObj[attr] = newObj[attr] || {};
            copyAttributes(
                oldObj[attr],
                newObj[attr],
                originalObj && originalObj[attr],
                isNonEdit || attr === 'nonEdit'
            );
        }
    }
}

/**
 * Checks the flag nonEdit and restores non-changeable values if required
 *
 * @alias checkNonEditable
 * @memberof tools
 * @param {object} oldObject source object
 * @param {object} newObject destination object
 *
 */
function checkNonEditable(oldObject, newObject) {
    if (!oldObject) {
        return true;
    }
    if (!oldObject.nonEdit && !newObject.nonEdit) {
        return true;
    }

    // if nonEdit is protected with password
    if (oldObject.nonEdit && oldObject.nonEdit.passHash) {
        // If new Object wants to update the nonEdit information
        if (newObject.nonEdit && newObject.nonEdit.password) {
            crypto = crypto || require('crypto');
            const hash = crypto.createHash('sha256').update(newObject.nonEdit.password.toString()).digest('base64');
            if (oldObject.nonEdit.passHash !== hash) {
                delete newObject.nonEdit;
                return false;
            } else {
                oldObject.nonEdit = deepClone(newObject.nonEdit);
                delete oldObject.nonEdit.password;
                delete newObject.nonEdit.password;
                oldObject.nonEdit.passHash = hash;
                newObject.nonEdit.passHash = hash;
            }
            copyAttributes(newObject.nonEdit, newObject, newObject);

            if (newObject.passHash) {
                delete newObject.passHash;
            }
            if (newObject.nonEdit && newObject.nonEdit.password) {
                delete newObject.nonEdit.password;
            }

            return true;
        } else {
            newObject.nonEdit = oldObject.nonEdit;
        }
    } else if (newObject.nonEdit) {
        oldObject.nonEdit = deepClone(newObject.nonEdit);
        if (newObject.nonEdit.password) {
            crypto = crypto || require('crypto');
            const hash = crypto.createHash('sha256').update(newObject.nonEdit.password.toString()).digest('base64');
            delete oldObject.nonEdit.password;
            delete newObject.nonEdit.password;
            oldObject.nonEdit.passHash = hash;
            newObject.nonEdit.passHash = hash;
        }
    }

    // restore settings
    copyAttributes(oldObject.nonEdit, newObject, oldObject);

    if (newObject.passHash) {
        delete newObject.passHash;
    }
    if (newObject.nonEdit && newObject.nonEdit.password) {
        delete newObject.nonEdit.password;
    }
    return true;
}

/**
 * @param {string} repoVersion
 * @param {string} installedVersion
 * @throws {Error} if version is invalid
 */
function upToDate(repoVersion, installedVersion) {
    // Check if the installed version is at least the repo version
    return semver.gte(installedVersion, repoVersion);
}

// TODO: this is only here for backward compatibility, if MULTIHOST password was still setup with old decryption
function decryptPhrase(password, data, callback) {
    crypto = crypto || require('crypto');
    const decipher = crypto.createDecipher('aes192', password);

    try {
        let decrypted = '';
        decipher.on('readable', () => {
            const data = decipher.read();
            if (data) {
                decrypted += data.toString('utf8');
            }
        });
        decipher.on('error', error => {
            console.error('Cannot decode secret: ' + error);
            callback(null);
        });

        decipher.on('end', () => callback(decrypted));

        decipher.write(data, 'hex');
        decipher.end();
    } catch (e) {
        console.error(`Cannot decode secret: ${e.message}`);
        callback(null);
    }
}

/**
 * Checks if multiple host objects exists, without using object views
 *
 * @param {object} objects the objects db
 * @return {Promise<boolean>} true if only one host object exists
 */
async function isSingleHost(objects) {
    const res = await objects.getObjectList({ startkey: 'system.host.', endkey: 'system.host.\u9999' });
    const hostObjs = res.rows.filter(obj => obj.value && obj.value.type === 'host');
    return hostObjs.length <= 1; // on setup no host object is there yet
}

/**
 * Checks if at least one host is running in a MH environment
 *
 * @param {object} objects the objects db
 * @param {object} states the states db
 * @return Promise<boolean> true if one or more hosts running else false
 */
async function isHostRunning(objects, states) {
    const res = await objects.getObjectViewAsync('system', 'host', { startkey: '', endkey: '\u9999' });

    for (const hostObj of res.rows) {
        const state = await states.getState(`${hostObj.id}.alive`);
        if (state.val) {
            return true;
        }
    }
    return false;
}

function getAppName() {
    if (fs.existsSync(__dirname + '/../../../../packages/controller')) {
        // dev install - GitHub folder is uppercase
        return 'ioBroker';
    }

    return 'iobroker';
}

function rmdirRecursiveSync(path) {
    if (fs.existsSync(path)) {
        fs.readdirSync(path).forEach(file => {
            const curPath = path + '/' + file;
            if (fs.statSync(curPath).isDirectory()) {
                // recurse
                rmdirRecursiveSync(curPath);
            } else {
                // delete file
                fs.unlinkSync(curPath);
            }
        });
        // delete (hopefully) empty folder
        try {
            fs.rmdirSync(path);
        } catch (e) {
            console.log('Cannot delete directory ' + path + ': ' + e.message);
        }
    }
}

function findIPs() {
    if (!lastCalculationOfIps || Date.now() - lastCalculationOfIps > 10000) {
        lastCalculationOfIps = Date.now();
        ownIpArr = [];
        try {
            const ifaces = require('os').networkInterfaces();
            Object.keys(ifaces).forEach(dev =>
                ifaces[dev].forEach(
                    details =>
                        // noinspection JSUnresolvedVariable
                        !details.internal && ownIpArr.push(details.address)
                )
            );
        } catch (e) {
            console.error(`Can not find local IPs: ${e.message}`);
        }
    }

    return ownIpArr;
}

function findPath(path, url) {
    if (!url) {
        return '';
    }
    if (url.substring(0, 'http://'.length) === 'http://' || url.substring(0, 'https://'.length) === 'https://') {
        return url;
    } else {
        if (path.substring(0, 'http://'.length) === 'http://' || path.substring(0, 'https://'.length) === 'https://') {
            return (path + url).replace(/\/\//g, '/').replace('http:/', 'http://').replace('https:/', 'https://');
        } else {
            if (url[0] === '/') {
                return __dirname + '/..' + url;
            } else {
                return __dirname + '/../' + path + url;
            }
        }
    }
}

function getMac(callback) {
    const macRegex = /(?:[a-z0-9]{2}[:-]){5}[a-z0-9]{2}/gi;
    const zeroRegex = /(?:[0]{2}[:-]){5}[0]{2}/;
    const command = process.platform.indexOf('win') === 0 ? 'getmac' : 'ifconfig || ip link';

    require('child_process').exec(command, { windowsHide: true }, (err, stdout, _stderr) => {
        if (err) {
            callback(err);
        } else {
            let macAddress;
            let match;
            let result = null;

            while (true) {
                match = macRegex.exec(stdout);
                if (!match) {
                    break;
                }
                macAddress = match[0];
                if (!zeroRegex.test(macAddress) && !result) {
                    result = macAddress;
                }
            }

            if (result === null) {
                callback(new Error('could not determine the mac address from:\n' + stdout));
            } else {
                callback(null, result.replace(/-/g, ':').toLowerCase());
            }
        }
    });
}

/**
 * Checks if we are running inside a docker container
 * @returns {boolean}
 */
function isDocker() {
    try {
        fs.statSync('/.dockerenv');
        return true;
    } catch {
        // ignore error
    }

    try {
        // check docker group
        return fs.readFileSync('/proc/self/cgroup', 'utf8').includes('docker');
    } catch {
        return false;
    }
}

// Build unique uuid based on MAC address if possible
function uuid(givenMac, callback) {
    if (typeof givenMac === 'function') {
        callback = givenMac;
        givenMac = '';
    }

    const _isDocker = isDocker();

    // return constant UUID for all CI environments to keep the statistics clean
    if (require('ci-info').isCI) {
        return callback('55travis-pipe-line-cior-githubaction');
    }

    let mac = givenMac !== null ? givenMac || '' : null;
    let u;

    if (!_isDocker && mac === '') {
        const ifaces = require('os').networkInterfaces();

        // Find first not empty MAC
        for (const n of Object.keys(ifaces)) {
            for (let c = 0; c < ifaces[n].length; c++) {
                if (ifaces[n][c].mac && ifaces[n][c].mac !== '00:00:00:00:00:00') {
                    mac = ifaces[n][c].mac;
                    break;
                }
            }

            if (mac) {
                break;
            }
        }
    }

    if (!_isDocker && mac === '') {
        return getMac((_err, mac) => uuid(mac || null, callback));
    }

    if (!_isDocker && mac) {
        const md5sum = require('crypto').createHash('md5');
        md5sum.update(mac);
        mac = md5sum.digest('hex');
        u =
            mac.substring(0, 8) +
            '-' +
            mac.substring(8, 12) +
            '-' +
            mac.substring(12, 16) +
            '-' +
            mac.substring(16, 20) +
            '-' +
            mac.substring(20);
    } else {
        // Returns a RFC4122 compliant v4 UUID https://gist.github.com/LeverOne/1308368 (DO WTF YOU WANT TO PUBLIC LICENSE)
        /** @type {any} */
        let a;
        let b;
        b = a = '';
        while (a++ < 36) {
            b += (a * 51) & 52 ? (a ^ 15 ? 8 ^ (Math.random() * (a ^ 20 ? 16 : 4)) : 4).toString(16) : '-';
        }
        u = b;
    }

    callback(u);
}

function updateUuid(newUuid, _objects, callback) {
    uuid('', _uuid => {
        _uuid = newUuid || _uuid;
        // Add vendor prefix to UUID
        if (fs.existsSync(VENDOR_FILE)) {
            try {
                const vendor = require(VENDOR_FILE);
                if (vendor.vendor && vendor.vendor.uuidPrefix && vendor.vendor.uuidPrefix.length === 2) {
                    _uuid = vendor.vendor.uuidPrefix + _uuid;
                }
            } catch {
                console.error(`Cannot parse ${VENDOR_FILE}`);
            }
        }

        _objects.setObject(
            'system.meta.uuid',
            {
                type: 'meta',
                common: {
                    name: 'uuid',
                    type: 'uuid'
                },
                ts: new Date().getTime(),
                from: 'system.host.' + getHostName() + '.tools',
                native: {
                    uuid: _uuid
                }
            },
            err => {
                if (err) {
                    console.error('object system.meta.uuid cannot be updated: ' + err);
                    callback();
                } else {
                    _objects.getObject('system.meta.uuid', (err, obj) => {
                        if (obj.native.uuid !== _uuid) {
                            console.error('object system.meta.uuid cannot be updated: write protected');
                        } else {
                            console.log('object system.meta.uuid created: ' + _uuid);
                        }
                        callback(_uuid);
                    });
                }
            }
        );
    });
}

/**
 * Generates a new uuid if non existing
 *
 * @param {object} objects - objects DB
 * @return {Promise<void|string>} uuid if successfully created/updated
 */
async function createUuid(objects) {
    const promiseCheckPassword = new Promise(resolve =>
        objects.getObject('system.user.admin', (err, obj) => {
            if (err || !obj) {
                password = password || require('./password');

                // Default Password for user 'admin' is application name in lower case
                password(module.exports.appName).hash(null, null, (err, res) => {
                    err && console.error(err);

                    // Create user here and not in io-package.js because of hash password
                    objects.setObject(
                        'system.user.admin',
                        {
                            type: 'user',
                            common: {
                                name: 'admin',
                                password: res,
                                dontDelete: true,
                                enabled: true
                            },
                            ts: new Date().getTime(),
                            from: `system.host.${getHostName()}.tools`,
                            native: {}
                        },
                        () => {
                            console.log('object system.user.admin created');
                            resolve();
                        }
                    );
                });
            } else {
                resolve();
            }
        })
    );
    const promiseCheckUuid = new Promise(resolve =>
        objects.getObject('system.meta.uuid', (err, obj) => {
            if (!err && obj && obj.native && obj.native.uuid) {
                const PROBLEM_UUIDS = [
                    'ab265f4a-67f9-a46a-c0b2-61e4b95cefe5',
                    '7abd3182-d399-f7bd-da19-9550d8babede',
                    'deb6f2a8-fe69-5491-0a50-a9f9b8f3419c',
                    'ec66c85e-fc36-f6f9-f1c9-f5a2882d23c7',
                    'e6203b03-f5f4-253a-e4f6-b295fc543ab7',
                    'd659fa3d-7ef9-202a-ea23-acd0aff67b24'
                ];

                // if COMMON invalid docker uuid
                if (PROBLEM_UUIDS.includes(obj.native.uuid)) {
                    // Read vis license
                    objects.getObject('system.adapter.vis.0', (err, licObj) => {
                        if (!licObj || !licObj.native || !licObj.native.license) {
                            // generate new UUID
                            updateUuid('', objects, _uuid => resolve(_uuid));
                        } else {
                            // decode obj.native.license
                            let data;
                            try {
                                data = jwt.decode(licObj.native.license);
                            } catch {
                                data = null;
                            }

                            if (!data || !data.uuid) {
                                // generate new UUID
                                updateUuid('', objects, __uuid => resolve(__uuid));
                            } else {
                                if (data.uuid !== obj.native.uuid) {
                                    updateUuid(data.correct ? data.uuid : '', objects, _uuid => resolve(_uuid));
                                } else {
                                    // Show error
                                    console.warn(
                                        `Your iobroker.vis license must be updated. Please contact info@iobroker.net to get a new license!`
                                    );
                                    console.warn(
                                        `Provide following information in email: ${data.email}, invoice: ${data.invoice}`
                                    );
                                    resolve();
                                }
                            }
                        }
                    });
                } else {
                    resolve();
                }
            } else {
                // generate new UUID
                updateUuid('', objects, _uuid => resolve(_uuid));
            }
        })
    );

    const result = await Promise.all([promiseCheckPassword, promiseCheckUuid]);
    return result[1];
}

// Download file to tmp or return file name directly
function getFile(urlOrPath, fileName, callback) {
    request = request || require('request');

    // If object was read
    if (
        urlOrPath.substring(0, 'http://'.length) === 'http://' ||
        urlOrPath.substring(0, 'https://'.length) === 'https://'
    ) {
        const tmpFile = `${__dirname}/../tmp/${fileName || Math.floor(Math.random() * 0xffffffe) + '.zip'}`;
        // Add some information to user-agent, like chrome, IE and Firefox do
        request({
            url: urlOrPath,
            gzip: true,
            headers: { 'User-Agent': `${module.exports.appName}, RND: ${randomID}, N: ${process.version}` }
        })
            .on('error', error => {
                console.log(`Cannot download "${tmpFile}": ${error}`);
                callback && callback(tmpFile);
            })
            .pipe(fs.createWriteStream(tmpFile))
            .on('close', () => {
                console.log('downloaded ' + tmpFile);
                callback && callback(tmpFile);
            });
    } else {
        try {
            if (fs.existsSync(urlOrPath)) {
                callback && callback(urlOrPath);
            } else if (fs.existsSync(`${__dirname}/../${urlOrPath}`)) {
                callback && callback(`${__dirname}/../${urlOrPath}`);
            } else if (fs.existsSync(`${__dirname}/../tmp/${urlOrPath}`)) {
                callback && callback(`${__dirname}/../tmp/${urlOrPath}`);
            } else {
                console.log('File not found: ' + urlOrPath);
                process.exit(EXIT_CODES.FILE_NOT_FOUND);
            }
        } catch (err) {
            console.log(`File "${urlOrPath}" could no be read: ${err.message}`);
            process.exit(EXIT_CODES.FILE_NOT_FOUND);
        }
    }
}

// Return content of the json file. Download it or read directly
function getJson(urlOrPath, agent, callback) {
    if (typeof agent === 'function') {
        callback = agent;
        agent = '';
    }
    agent = agent || '';

    request = request || require('request');
    let sources = {};
    // If object was read
    if (urlOrPath && typeof urlOrPath === 'object') {
        if (callback) {
            callback(urlOrPath);
        }
    } else if (!urlOrPath) {
        console.log('Empty url!');
        if (callback) {
            callback(null);
        }
    } else {
        if (
            urlOrPath.substring(0, 'http://'.length) === 'http://' ||
            urlOrPath.substring(0, 'https://'.length) === 'https://'
        ) {
            request(
                {
                    url: urlOrPath,
                    timeout: 10000,
                    gzip: true,
                    headers: { 'User-Agent': agent }
                },
                (error, response, body) => {
                    if (error || !body || response.statusCode !== 200) {
                        console.warn(`Cannot download json from ${urlOrPath}. Error: ${error || body}`);
                        if (callback) {
                            callback(null, urlOrPath);
                        }
                        return;
                    }
                    try {
                        sources = JSON.parse(body);
                    } catch {
                        console.error('Json file is invalid on ' + urlOrPath);
                        if (callback) {
                            callback(null, urlOrPath);
                        }
                        return;
                    }

                    if (callback) {
                        callback(sources, urlOrPath);
                    }
                }
            ).on('error', _error => {
                //console.log('Cannot download json from ' + urlOrPath + '. Error: ' + error);
                //if (callback) callback(null, urlOrPath);
            });
        } else {
            if (fs.existsSync(urlOrPath)) {
                try {
                    sources = fs.readJSONSync(urlOrPath);
                } catch (e) {
                    console.log('Cannot parse json file from ' + urlOrPath + '. Error: ' + e.message);
                    if (callback) {
                        callback(null, urlOrPath);
                    }
                    return;
                }
                if (callback) {
                    callback(sources, urlOrPath);
                }
            } else if (fs.existsSync(__dirname + '/../' + urlOrPath)) {
                try {
                    sources = fs.readJSONSync(__dirname + '/../' + urlOrPath);
                } catch (e) {
                    console.log(
                        'Cannot parse json file from ' + __dirname + '/../' + urlOrPath + '. Error: ' + e.message
                    );
                    if (callback) {
                        callback(null, urlOrPath);
                    }
                    return;
                }
                if (callback) {
                    callback(sources, urlOrPath);
                }
            } else if (fs.existsSync(__dirname + '/../tmp/' + urlOrPath)) {
                try {
                    sources = fs.readJSONSync(__dirname + '/../tmp/' + urlOrPath);
                } catch (e) {
                    console.log(
                        'Cannot parse json file from ' + __dirname + '/../tmp/' + urlOrPath + '. Error: ' + e.message
                    );
                    if (callback) {
                        callback(null, urlOrPath);
                    }
                    return;
                }
                if (callback) {
                    callback(sources, urlOrPath);
                }
            } else {
                //if (urlOrPath.indexOf('/example/') === -1) console.log('Json file not found: ' + urlOrPath);
                if (callback) {
                    callback(null, urlOrPath);
                }
            }
        }
    }
}

/**
 * Return content of the json file. Download it or read directly
 * @param {string|object} urlOrPath URL where the json file could be found
 * @param {string} agent optional agent identifier like "Windows Chrome 12.56"
 * @returns {object} json object
 */
async function getJsonAsync(urlOrPath, agent) {
    agent = agent || '';

    axios = axios || require('axios');
    let sources = {};
    // If object was read
    if (urlOrPath && typeof urlOrPath === 'object') {
        return urlOrPath;
    } else if (!urlOrPath) {
        console.log('Empty url!');
        return null;
    } else {
        if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
            try {
                const result = await axios(urlOrPath, {
                    timeout: 10000,
                    headers: { 'User-Agent': agent },
                    validateStatus: status => status !== 200
                });
                return result.data;
            } catch (error) {
                console.warn(`Cannot download json from ${urlOrPath}. Error: ${error}`);
                return null;
            }
        } else {
            if (fs.existsSync(urlOrPath)) {
                try {
                    sources = fs.readJSONSync(urlOrPath);
                } catch (e) {
                    console.warn(`Cannot parse json file from ${urlOrPath}. Error: ${e.message}`);
                    return null;
                }
                return sources;
            } else if (fs.existsSync(__dirname + '/../' + urlOrPath)) {
                try {
                    sources = fs.readJSONSync(`${__dirname}/../${urlOrPath}`);
                } catch (e) {
                    console.warn(`Cannot parse json file from ${__dirname}/../${urlOrPath}. Error: ${e.message}`);
                    return null;
                }
                return sources;
            } else if (fs.existsSync(`${__dirname}/../tmp/${urlOrPath}`)) {
                try {
                    sources = fs.readJSONSync(`${__dirname}/../tmp/${urlOrPath}`);
                } catch (e) {
                    console.log(`Cannot parse json file from ${__dirname}/../tmp/${urlOrPath}. Error: ${e.message}`);
                    return null;
                }
                return sources;
            } else {
                //if (urlOrPath.indexOf('/example/') === -1) console.log('Json file not found: ' + urlOrPath);
                return null;
            }
        }
    }
}

function scanDirectory(dirName, list, regExp) {
    if (fs.existsSync(dirName)) {
        let dirs;
        try {
            dirs = fs.readdirSync(dirName);
        } catch (e) {
            console.log(`Cannot read or parse ${dirName}: ${e.message}`);
            return;
        }
        for (let i = 0; i < dirs.length; i++) {
            try {
                const fullPath = path.join(dirName, dirs[i]);
                const fileIoName = path.join(fullPath, 'io-package.json');
                const fileName = path.join(fullPath, 'package.json');
                if (regExp.test(dirs[i]) && fs.existsSync(fileIoName)) {
                    const ioPackage = fs.readJSONSync(fileIoName);
                    const package_ = fs.existsSync(fileName) ? fs.readJSONSync(fileName) : {};
                    const localIcon = ioPackage.common.icon
                        ? `/adapter/${dirs[i].substring(module.exports.appName.length + 1)}/${ioPackage.common.icon}`
                        : '';
                    //noinspection JSUnresolvedVariable
                    list[ioPackage.common.name] = {
                        controller: ioPackage.common.controller || false,
                        version: ioPackage.common.version,
                        icon: ioPackage.common.extIcon || localIcon,
                        localIcon,
                        title: ioPackage.common.title, // deprecated 2021.04.18 BF
                        titleLang: ioPackage.common.titleLang,
                        desc: ioPackage.common.desc,
                        platform: ioPackage.common.platform,
                        keywords: ioPackage.common.keywords,
                        readme: ioPackage.common.readme,
                        type: ioPackage.common.type,
                        license: ioPackage.common.license
                            ? ioPackage.common.license
                            : package_.licenses && package_.licenses.length
                            ? package_.licenses[0].type
                            : '',
                        licenseUrl: package_.licenses && package_.licenses.length ? package_.licenses[0].url : ''
                    };
                }
            } catch (e) {
                console.log(
                    `Cannot read or parse ${__dirname}/../node_modules/${dirs[i]}/io-package.json: ${e.message}`
                );
            }
        }
    }
}

/**
 * Get list of all installed adapters and controller version on this host
 * @param {string} [hostRunningVersion] Version of the running js-controller, will be included in the returned information if provided
 * @returns {object} object containing information about installed host
 */
function getInstalledInfo(hostRunningVersion) {
    const result = {};
    const fullPath = getControllerDir();

    // Get info about host
    let ioPackage;
    try {
        ioPackage = fs.readJSONSync(path.join(fullPath, 'io-package.json'));
    } catch (e) {
        console.error(`Cannot get installed host information: ${e.message}`);
    }
    const package_ = fs.existsSync(path.join(fullPath, 'package.json'))
        ? fs.readJSONSync(path.join(fullPath, 'package.json'))
        : {};
    const regExp = new RegExp(`^${module.exports.appName}\\.`, 'i');

    if (ioPackage) {
        result[ioPackage.common.name] = {
            controller: true,
            version: ioPackage.common.version,
            icon: ioPackage.common.extIcon || ioPackage.common.icon,
            title: ioPackage.common.title, // deprecated 2021.04.18 BF
            titleLang: ioPackage.common.titleLang,
            desc: ioPackage.common.desc,
            platform: ioPackage.common.platform,
            keywords: ioPackage.common.keywords,
            readme: ioPackage.common.readme,
            runningVersion: hostRunningVersion,
            license: ioPackage.common.license
                ? ioPackage.common.license
                : package_.licenses && package_.licenses.length
                ? package_.licenses[0].type
                : '',
            licenseUrl: package_.licenses && package_.licenses.length ? package_.licenses[0].url : ''
        };
    }

    // we scan the sub node modules of controller and same hierarchy as controller
    scanDirectory(path.join(fullPath, 'node_modules'), result, regExp);
    scanDirectory(path.join(fullPath, '..'), result, regExp);

    // Warning! Do not checkin this code
    if (
        fs.existsSync(
            path.join(__dirname, `../../../../../node_modules/${module.exports.appName.toLowerCase()}.js-controller`)
        ) ||
        fs.existsSync(path.join(__dirname, `../../../../../node_modules/${module.exports.appName}.js-controller`))
    ) {
        scanDirectory(path.join(__dirname, '../../../../../node_modules'), result, regExp);
    }

    return result;
}

/**
 * Reads an adapter's npm version
 * @param {string | null} adapter The adapter to read the npm version from. Null for the root ioBroker packet
 * @param {(err: Error | null, version?: string) => void} [callback]
 */
function getNpmVersion(adapter, callback) {
    adapter = adapter ? module.exports.appName + '.' + adapter : module.exports.appName;
    adapter = adapter.toLowerCase();

    const cliCommand = `npm view ${adapter}@latest version`;

    const exec = require('child_process').exec;
    exec(cliCommand, { timeout: 2000, windowsHide: true }, (error, stdout, _stderr) => {
        let version;
        if (error) {
            // command failed
            if (typeof callback === 'function') {
                callback(error);
                return;
            }
        } else if (stdout) {
            version = semver.valid(stdout.trim());
        }
        if (typeof callback === 'function') {
            callback(null, version);
        }
    });
}

function getIoPack(sources, name, callback) {
    getJson(sources[name].meta, ioPack => {
        const packUrl = sources[name].meta.replace('io-package.json', 'package.json');
        if (!ioPack) {
            if (sources._helper) {
                sources._helper.failCounter.push(name);
            }
            if (callback) {
                callback(sources, name);
            }
        } else {
            setImmediate(() => {
                getJson(packUrl, pack => {
                    const version = sources[name].version;
                    const type = sources[name].type;
                    // If installed from git or something else
                    // js-controller is exception, because can be installed from npm and from git
                    if (sources[name].url && name !== 'js-controller') {
                        if (ioPack && ioPack.common) {
                            sources[name] = extend(true, sources[name], ioPack.common);

                            // overwrite type of adapter from repository
                            if (type) {
                                sources[name].type = type;
                            }
                            if (pack && pack.licenses && pack.licenses.length) {
                                if (!sources[name].license) {
                                    sources[name].license = pack.licenses[0].type;
                                }
                                if (!sources[name].licenseUrl) {
                                    sources[name].licenseUrl = pack.licenses[0].url;
                                }
                            }
                        }

                        if (callback) {
                            callback(sources, name);
                        }
                    } else {
                        if (ioPack && ioPack.common) {
                            sources[name] = extend(true, sources[name], ioPack.common);
                            if (pack && pack.licenses && pack.licenses.length) {
                                if (!sources[name].license) {
                                    sources[name].license = pack.licenses[0].type;
                                }
                                if (!sources[name].licenseUrl) {
                                    sources[name].licenseUrl = pack.licenses[0].url;
                                }
                            }
                        }

                        // overwrite type of adapter from repository
                        if (type) {
                            sources[name].type = type;
                        }

                        if (version) {
                            sources[name].version = version;
                            if (callback) {
                                callback(sources, name);
                            }
                        } else {
                            if (
                                sources[name].meta.substring(0, 'http://'.length) === 'http://' ||
                                sources[name].meta.substring(0, 'https://'.length) === 'https://'
                            ) {
                                //installed from npm
                                getNpmVersion(name, (_err, version) => {
                                    if (version) {
                                        sources[name].version = version;
                                    } else {
                                        sources[name].version = 'npm error';
                                    }
                                    if (callback) {
                                        callback(sources, name);
                                    }
                                });
                            } else {
                                if (callback) {
                                    callback(sources, name);
                                }
                            }
                        }
                    }
                });
            });
        }
    });
}

function _getRepositoryFile(sources, path, callback) {
    if (!sources._helper) {
        let count = 0;
        for (const _name in sources) {
            if (!Object.prototype.hasOwnProperty.call(sources, _name)) {
                continue;
            }
            count++;
        }
        sources._helper = { failCounter: [] };

        sources._helper.timeout = setTimeout(() => {
            if (sources._helper) {
                delete sources._helper;
                for (const __name of Object.keys(sources)) {
                    if (sources[__name].processed !== undefined) {
                        delete sources[__name].processed;
                    }
                }
                if (callback) {
                    callback(`Timeout by read all package.json (${count}) seconds`, sources);
                }
                callback = null;
            }
        }, count * 1000);
    }

    for (const name of Object.keys(sources)) {
        if (sources[name].processed || name === '_helper') {
            continue;
        }

        sources[name].processed = true;
        if (sources[name].url) {
            sources[name].url = findPath(path, sources[name].url);
        }
        if (sources[name].meta) {
            sources[name].meta = findPath(path, sources[name].meta);
        }
        if (sources[name].icon) {
            sources[name].icon = findPath(path, sources[name].icon);
        }

        if (!sources[name].name && sources[name].meta) {
            getIoPack(sources, name, _ignore => {
                if (sources._helper) {
                    if (sources._helper.failCounter.length > 10) {
                        clearTimeout(sources._helper.timeout);
                        delete sources._helper;
                        for (const _name of Object.keys(sources)) {
                            if (sources[_name].processed !== undefined) {
                                delete sources[_name].processed;
                            }
                        }
                        if (callback) {
                            callback('Looks like there is no internet.', sources);
                        }
                        callback = null;
                    } else {
                        // process next
                        setImmediate(() => _getRepositoryFile(sources, path, callback));
                    }
                }
            });
            return;
        }
    }

    // all packages are processed
    if (sources._helper) {
        let err;
        if (sources._helper.failCounter.length) {
            err = 'Following packages cannot be read: ' + sources._helper.failCounter.join(', ');
        }
        clearTimeout(sources._helper.timeout);
        delete sources._helper;
        for (const __name of Object.keys(sources)) {
            if (sources[__name].processed !== undefined) {
                delete sources[__name].processed;
            }
        }
        if (callback) {
            callback(err, sources);
        }
        callback = null;
    }
}

function _checkRepositoryFileHash(urlOrPath, additionalInfo, callback) {
    request = request || require('request');

    // read hash of file
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
        urlOrPath = urlOrPath.replace(/\.json$/, '-hash.json');
        let json = null;
        request({ url: urlOrPath, timeout: 10000, gzip: true }, (error, response, body) => {
            if (error || !body || response.statusCode !== 200) {
                console.warn(`Cannot download json from ${urlOrPath}. Error: ${error || body}`);
            } else {
                try {
                    json = JSON.parse(body);
                } catch {
                    console.error('Json file is invalid on ' + urlOrPath);
                }
            }
            if (json && json.hash) {
                // The hash download was successful
                if (additionalInfo && additionalInfo.sources && json.hash === additionalInfo.hash) {
                    // The hash is the same as for the cached sources
                    console.log('hash unchanged, use cached sources');
                    callback(null, additionalInfo.sources, json.hash);
                } else {
                    // Either we have no sources cached or the hash changed
                    // => force download of new sources
                    console.log('hash changed or no sources cached => force download of new sources');
                    callback(null, null, json.hash);
                }
            } else {
                // Could not download new sources, use the old ones
                console.log('failed to download new sources, use cached sources');
                callback(null, additionalInfo.sources, '');
            }
        }).on('error', _error => {
            //console.log('Cannot download json from ' + urlOrPath + '. Error: ' + error);
            //if (callback) callback(null, urlOrPath);
        });
    } else {
        // it is a file and file has not hash
        callback(null, null, 0);
    }
}

/**
 * Get list of all adapters and controller in some repository file or in /conf/source-dist.json
 *
 * @alias getRepositoryFile
 * @memberof tools
 * @param {string} urlOrPath URL starting with http:// or https:// or local file link
 * @param {object} additionalInfo destination object
 * @param {function} callback function (err, sources, actualHash) { }
 *
 */
function getRepositoryFile(urlOrPath, additionalInfo, callback) {
    let sources = {};
    let path = '';

    if (typeof additionalInfo === 'function') {
        callback = additionalInfo;
        additionalInfo = {};
    }

    additionalInfo = additionalInfo || {};

    extend = extend || require('node.extend');

    if (urlOrPath) {
        const parts = urlOrPath.split('/');
        path = parts.splice(0, parts.length - 1).join('/') + '/';
    }

    // If object was read
    if (urlOrPath && typeof urlOrPath === 'object') {
        if (typeof callback === 'function') {
            callback(null, urlOrPath);
        }
    } else if (!urlOrPath) {
        try {
            sources = fs.readJSONSync(getDefaultDataDir() + 'sources.json');
        } catch {
            sources = {};
        }
        try {
            const sourcesDist = fs.readJSONSync(__dirname + '/../conf/sources-dist.json');
            sources = extend(true, sourcesDist, sources);
        } catch {
            // continue regardless of error
        }

        for (const s of Object.keys(sources)) {
            if (additionalInfo[s] && additionalInfo[s].published) {
                sources[s].published = additionalInfo[s].published;
            }
        }

        _getRepositoryFile(sources, path, err => {
            if (err) {
                console.error(`[${new Date()}] ${err}`);
            }
            if (typeof callback === 'function') {
                callback(err, sources);
            }
        });
    } else {
        let agent = '';
        if (additionalInfo) {
            // Add some information to user-agent, like chrome, IE and Firefox do
            agent = `${additionalInfo.name}, RND: ${additionalInfo.randomID || randomID}, Node:${
                additionalInfo.node
            }, V:${additionalInfo.controller}`;
        }

        // load hash of file first to not load the whole 1MB of sources
        _checkRepositoryFileHash(urlOrPath, additionalInfo, (err, sources, actualSourcesHash) => {
            if (!err && sources) {
                // Source file was not changed
                typeof callback === 'function' && callback(err, sources, actualSourcesHash);
            } else {
                getJson(urlOrPath, agent, sources => {
                    if (sources) {
                        for (const s of Object.keys(sources)) {
                            if (additionalInfo[s] && additionalInfo[s].published) {
                                sources[s].published = additionalInfo[s].published;
                            }
                        }
                        setImmediate(() =>
                            _getRepositoryFile(sources, path, err => {
                                err && console.error(`[${new Date()}] ${err}`);
                                typeof callback === 'function' && callback(err, sources, actualSourcesHash);
                            })
                        );
                    } else {
                        // return cached sources, because no sources found
                        console.log(
                            `failed to download new sources, ${
                                additionalInfo.sources ? 'use cached sources' : 'no cached sources available'
                            }`
                        );
                        return maybeCallbackWithError(
                            callback,
                            `Cannot read "${urlOrPath}"`,
                            additionalInfo.sources,
                            ''
                        );
                    }
                });
            }
        });
    }
}

/**
 * Read on repository
 *
 * @alias getRepositoryFileAsync
 * @memberof tools
 * @param {string} url URL starting with http:// or https:// or local file link
 * @param {string} hash actual hash
 * @param {boolean} force Force repository update despite on hash
 * @param {object} _actualRepo Actual repository
 *
 */
async function getRepositoryFileAsync(url, hash, force, _actualRepo) {
    let _hash;
    if (_actualRepo && !force && hash && (url.startsWith('http://') || url.startsWith('https://'))) {
        axios = axios || require('axios');
        _hash = await axios({ url: url.replace(/\.json$/, '-hash.json'), timeout: 10000 });
        if (_hash && _hash.data && hash === _hash.data.hash) {
            return _actualRepo;
        }
    }

    let data;

    if (url.startsWith('http://') || url.startsWith('https://')) {
        axios = axios || require('axios');
        if (!_hash) {
            _hash = await axios({ url: url.replace(/\.json$/, '-hash.json'), timeout: 10000 });
        }

        if (_actualRepo && hash && _hash && _hash.data && _hash.data.hash === hash) {
            data = _actualRepo;
        } else {
            const agent = `${module.exports.appName}, RND: ${randomID}, Node:${process.version}, V:${
                require('../../package.json').version
            }`;
            data = await axios({
                url,
                timeout: 10000,
                headers: { 'User-Agent': agent }
            });
            data = data.data;
        }
    } else {
        if (fs.existsSync(url)) {
            try {
                data = JSON.parse(fs.readFileSync(url).toString('utf8'));
            } catch (e) {
                throw new Error(`Error: Cannot read or parse file "${url}": ${e}`);
            }
        } else {
            throw new Error(`Error: Cannot find file "${url}"`);
        }
    }

    return {
        json: data,
        changed: _hash && _hash.data ? hash !== _hash.data.hash : true,
        hash: _hash && _hash.data ? _hash.data.hash : ''
    };
}

/**
 * Sends the given object to the diagnosis server
 *
 * @param {object} obj - diagnosis object
 * @return {Promise<void>}
 */
async function sendDiagInfo(obj) {
    const objStr = JSON.stringify(obj);
    console.log(`Send diag info: ${objStr}`);
    axios = axios || require('axios');
    const params = new URLSearchParams();
    params.append('data', objStr);
    const config = {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 4000
    };

    try {
        await axios.post(`http://download.${module.exports.appName}.net/diag.php`, params, config);
    } catch (e) {
        console.log(`Cannot send diag info: ${e.message}`);
    }
}

/**
 * Finds the adapter directory of a given adapter
 *
 * @alias getAdapterDir
 * @memberof tools
 * @param {string} adapter name of the adapter, e.g. hm-rpc
 * @returns {string|null} path to adapter directory or null if no directory found
 */
function getAdapterDir(adapter) {
    const appName = module.exports.appName;

    // snip off 'iobroker.'
    if (adapter.startsWith(appName + '.')) {
        adapter = adapter.substring(appName.length + 1);
    }
    // snip off instance id
    if (/\.\d+$/.test(adapter)) {
        adapter = adapter.substr(0, adapter.lastIndexOf('.'));
    }

    const possibilities = [`${appName.toLowerCase()}.${adapter}/package.json`, `${appName}.${adapter}/package.json`];

    /** @type {string} */
    let adapterPath;
    for (const possibility of possibilities) {
        // special case to not read adapters from js-controller/node_module/adapter and check first in parent directory
        if (fs.existsSync(`${__dirname}/../../${possibility}`)) {
            adapterPath = `${__dirname}/../../${possibility}`;
        } else {
            try {
                adapterPath = require.resolve(possibility);
            } catch {
                // not found
            }
        }
        if (adapterPath) {
            break;
        }
    }

    if (!adapterPath) {
        return null; // inactive
    } else {
        const parts = path.normalize(adapterPath).split(/[\\/]/g);
        parts.pop();
        return parts.join('/');
    }
}

/**
 * Returns the hostname of this host
 * @alias getHostName
 * @returns {string}
 */
function getHostName() {
    // for tests purposes
    if (process.env.IOB_HOSTNAME) {
        return process.env.IOB_HOSTNAME;
    }
    try {
        const configName = getConfigFileName();
        const config = fs.readJSONSync(configName);
        return config.system ? config.system.hostname || require('os').hostname() : require('os').hostname();
    } catch {
        return require('os').hostname();
    }
}

/**
 * Read version of system npm
 *
 * @alias getSystemNpmVersion
 * @memberof Tools
 * @param {function} callback return result
 *        <pre><code>
 *            function (err, version) {
 *              adapter.log.debug('NPM version is: ' + version);
 *            }
 *        </code></pre>
 */
function getSystemNpmVersion(callback) {
    const exec = require('child_process').exec;

    // remove local node_modules\.bin dir from path
    // or we potentially get a wrong npm version
    const newEnv = Object.assign({}, process.env);
    newEnv.PATH = (newEnv.PATH || newEnv.Path || newEnv.path)
        .split(path.delimiter)
        .filter(dir => {
            dir = dir.toLowerCase();
            return !dir.includes('iobroker') || !dir.includes(path.join('node_modules', '.bin'));
        })
        .join(path.delimiter);
    try {
        let timeout = setTimeout(() => {
            timeout = null;
            if (callback) {
                callback('timeout');
                callback = null;
            }
        }, 10000);

        exec('npm -v', { encoding: 'utf8', env: newEnv, windowsHide: true }, (error, stdout) => {
            //, stderr) {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            if (stdout) {
                stdout = semver.valid(stdout.trim());
            }
            if (callback) {
                callback(error, stdout);
                callback = null;
            }
        });
    } catch (e) {
        if (callback) {
            callback(e);
            callback = null;
        }
    }
}

const getSystemNpmVersionAsync = promisify(getSystemNpmVersion);

/**
 * @typedef {object} InstallNodeModuleOptions
 * @property {boolean} [unsafePerm] Whether the `--unsafe-perm` flag should be used
 * @property {boolean} [debug] Whether to include `stderr` in the output and increase the loglevel to include more than errors
 * @property {string} [cwd] Which directory to work in. If none is given, this defaults to ioBroker's root directory.
 */

/**
 * Installs a node module using npm or a similar package manager
 * @param {string} npmUrl Which node module to install
 * @param {InstallNodeModuleOptions} options Options for the installation
 * @returns {Promise<import('@alcalzone/pak').CommandResult>}
 */
async function installNodeModule(npmUrl, options = {}) {
    // Figure out which package manager is in charge (probably npm at this point)
    const pak = await detectPackageManager(
        typeof options.cwd === 'string'
            ? // If a cwd was provided, use it
              { cwd: options.cwd }
            : // Otherwise find the ioBroker root dir
              {
                  cwd: __dirname,
                  setCwdToPackageRoot: true
              }
    );
    // By default, don't print all the stuff the package manager spits out
    if (!options.debug) {
        pak.loglevel = 'error';
    }

    // Set up streams to pass the command output through
    if (options.debug) {
        const stdall = new PassThrough();
        pak.stdall = stdall;
        pipeLinewise(stdall, process.stdout);
    } else {
        const stdout = new PassThrough();
        pak.stdout = stdout;
        pipeLinewise(stdout, process.stdout);
    }

    // And install the module
    /** @type {import('@alcalzone/pak').InstallOptions} */
    const installOpts = {};
    if (options.unsafePerm) {
        installOpts.additionalArgs = ['--unsafe-perm'];
    }
    return pak.install([npmUrl], installOpts);
}

/**
 * @typedef {object} UninstallNodeModuleOptions
 * @property {boolean} [debug] Whether to include `stderr` in the output and increase the loglevel to include more than errors
 * @property {string} [cwd] Which directory to work in. If none is given, this defaults to ioBroker's root directory.
 */

/**
 * Uninstalls a node module using npm or a similar package manager
 * @param {string} packageName Which node module to uninstall
 * @param {UninstallNodeModuleOptions} options Options for the installation
 * @returns {Promise<import('@alcalzone/pak').CommandResult>}
 */
async function uninstallNodeModule(packageName, options = {}) {
    // Figure out which package manager is in charge (probably npm at this point)
    const pak = await detectPackageManager(
        typeof options.cwd === 'string'
            ? // If a cwd was provided, use it
              { cwd: options.cwd }
            : // Otherwise find the ioBroker root dir
              {
                  cwd: __dirname,
                  setCwdToPackageRoot: true
              }
    );
    // By default, don't print all the stuff the package manager spits out
    if (!options.debug) {
        pak.loglevel = 'error';
    }

    // Set up streams to pass the command output through
    if (options.debug) {
        const stdall = new PassThrough();
        pak.stdall = stdall;
        pipeLinewise(stdall, process.stdout);
    } else {
        const stdout = new PassThrough();
        pak.stdout = stdout;
        pipeLinewise(stdout, process.stdout);
    }

    return pak.uninstall([packageName]);
}

/**
 * @typedef {object} RebuildNodeModulesOptions
 * @property {boolean} [debug] Whether to include `stderr` in the output and increase the loglevel to include more than errors
 * @property {string} [cwd] Which directory to work in. If none is given, this defaults to ioBroker's root directory.
 */

/**
 * Rebuilds all native node_modules that are dependencies of the project in the current working directory / project root.
 * If `options.cwd` is given, the directory must contain a lockfile.
 * @param {RebuildNodeModulesOptions} options Options for the rebuild
 * @returns {Promise<import('@alcalzone/pak').CommandResult>}
 */
async function rebuildNodeModules(options = {}) {
    // Figure out which package manager is in charge (probably npm at this point)
    const pak = await detectPackageManager(
        typeof options.cwd === 'string'
            ? // If a cwd was provided, use it
              { cwd: options.cwd }
            : // Otherwise find the ioBroker root dir
              {
                  cwd: __dirname,
                  setCwdToPackageRoot: true
              }
    );
    // By default, don't print all the stuff the package manager spits out
    if (!options.debug) {
        pak.loglevel = 'error';
    }

    // Set up streams to pass the command output through
    if (options.debug) {
        const stdall = new PassThrough();
        pak.stdall = stdall;
        pipeLinewise(stdall, process.stdout);
    } else {
        const stdout = new PassThrough();
        pak.stdout = stdout;
        pipeLinewise(stdout, process.stdout);
    }

    return pak.rebuild();
}

/**
 * Read disk free space
 *
 * @alias getDiskInfo
 * @memberof Tools
 * @param {string} platform result of os.platform() (win32 => Windows, darwin => OSX)
 * @param {function} callback return result
 *        <pre><code>
 *            function (err, infos) {
 *              adapter.log.debug('Disks sizes is: ' + info['Disk size'] + ' - ' + info['Disk free']);
 *            }
 *        </code></pre>
 */
function getDiskInfo(platform, callback) {
    platform = platform || require('os').platform();
    if (diskusage) {
        try {
            const path = platform === 'win32' ? __dirname.substring(0, 2) : '/';
            const info = diskusage.checkSync(path);
            return callback && callback(null, { 'Disk size': info.total, 'Disk free': info.free });
        } catch (err) {
            console.log(err);
        }
    } else {
        const exec = require('child_process').exec;
        try {
            if (platform === 'Windows' || platform === 'win32') {
                // Caption  FreeSpace     Size
                // A:
                // C:       66993807360   214640357376
                // D:
                // Y:       116649795584  148368257024
                // Z:       116649795584  148368257024
                const disk = __dirname.substring(0, 2).toUpperCase();

                exec(
                    'wmic logicaldisk get size,freespace,caption',
                    {
                        encoding: 'utf8',
                        windowsHide: true
                    },
                    (error, stdout) => {
                        //, stderr) {
                        if (stdout) {
                            const lines = stdout.split('\n');
                            const line = lines.find(line => {
                                const parts = line.split(/\s+/);
                                return parts[0].toUpperCase() === disk;
                            });
                            if (line) {
                                const parts = line.split(/\s+/);
                                return (
                                    callback &&
                                    callback(error, {
                                        'Disk size': parseInt(parts[2]),
                                        'Disk free': parseInt(parts[1])
                                    })
                                );
                            }
                        }
                        callback && callback(error, null);
                    }
                );
            } else {
                exec('df -k /', { encoding: 'utf8', windowsHide: true }, (error, stdout) => {
                    //, stderr) {
                    // Filesystem            1K-blocks    Used Available Use% Mounted on
                    // /dev/mapper/vg00-lv01 162544556 9966192 145767152   7% /
                    try {
                        if (stdout) {
                            const parts = stdout.split('\n')[1].split(/\s+/);
                            return (
                                callback &&
                                callback(error, {
                                    'Disk size': parseInt(parts[1]) * 1024,
                                    'Disk free': parseInt(parts[3]) * 1024
                                })
                            );
                        }
                    } catch {
                        // continue regardless of error
                    }
                    callback && callback(error, null);
                });
            }
        } catch (e) {
            callback && callback(e, null);
        }
    }
}

const getDiskInfoAsync = promisify(getDiskInfo);

/**
 * Returns information about a certificate
 *
 *
 *  Following info will be returned:
 *     - certificate: the certificate itself
 *     - serialNumber: serial number
 *     - signature: type of signature as text like "RSA",
 *     - keyLength: bits used for encryption key like 2048
 *     - issuer: issuer of the certificate
 *     - subject: subject that is signed
 *     - dnsNames: server name this certificate belong to
 *     - keyUsage: this certificate can be used for the followinf puposes
 *     - extKeyUsage: usable or client, server or ...
 *     - validityNotBefore: certificate validity start datetime
 *     - validityNotAfter: certificate validity end datetime
 *
 * @alias getCertificateInfo
 * @memberof Tools
 * @param {string} cert
 * @return certificate information object
 */
function getCertificateInfo(cert) {
    let info = null;

    if (!cert) {
        return null;
    }
    // https://github.com/digitalbazaar/forge
    forge.options.usePureJavaScript = false;
    const pki = forge.pki;

    let certFile = null;
    try {
        if (typeof cert === 'string' && cert.length < 1024 && fs.existsSync(cert)) {
            certFile = cert;
            cert = fs.readFileSync(cert, 'utf8');
        }

        const crt = pki.certificateFromPem(cert);

        info = {
            certificateFilename: certFile,
            certificate: cert,
            serialNumber: crt.serialNumber,
            signature: pki.oids[crt.signatureOid],
            keyLength: crt.publicKey.n.toString(2).length,
            issuer: crt.issuer,
            subject: crt.subject,
            dnsNames: crt.getExtension('subjectAltName').altNames,
            keyUsage: crt.getExtension('keyUsage'),
            extKeyUsage: crt.getExtension('extKeyUsage'),
            validityNotBefore: crt.validity.notBefore,
            validityNotAfter: crt.validity.notAfter
        };

        // do not return info about values
        delete info.keyUsage.value;
        delete info.extKeyUsage.value;
        return info;
    } catch {
        return null;
    }
}

/**
 * Returns default SSL certificates (private and public)
 *
 *
 *  Following info will be returned:
 *     - defaultPrivate: private RSA key
 *     - defaultPublic: public certificate
 *
 * @alias generateDefaultCertificates
 * @memberof Tools
 * @returns {{ defaultPrivate: any[];defaultPublic: any[] }}
 *        <pre><code>
 *            const certificates = tools.generateDefaultCertificates();
 *        </code></pre>
 */
function generateDefaultCertificates() {
    // If at any time you wish to disable the use of native code, where available, for particular forge features
    // like its secure random number generator, you may set the forge.options.usePureJavaScript flag to true. It
    // is not recommended that you set this flag as native code is typically more performant and may have stronger
    // security properties. It may be useful to set this flag to test certain features that you plan to run in
    // environments that are different from your testing environment.
    // https://github.com/digitalbazaar/forge
    forge.options.usePureJavaScript = false;
    const pki = forge.pki;
    const keys = pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 });
    const cert = pki.createCertificate();

    cert.publicKey = keys.publicKey;
    cert.serialNumber = '0' + makeid(17);
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

    const subAttrs = [
        { name: 'commonName', value: getHostName() },
        { name: 'organizationName', value: 'ioBroker GmbH' },
        { shortName: 'OU', value: 'iobroker' }
    ];

    const issAttrs = [
        { name: 'commonName', value: 'iobroker' },
        { name: 'organizationName', value: 'ioBroker GmbH' },
        { shortName: 'OU', value: 'iobroker' }
    ];

    cert.setSubject(subAttrs);
    cert.setIssuer(issAttrs);

    cert.setExtensions([
        {
            name: 'basicConstraints',
            critical: true,
            cA: false
        },
        {
            name: 'keyUsage',
            critical: true,
            digitalSignature: true,
            contentCommitment: true,
            keyEncipherment: true,
            dataEncipherment: true,
            keyAgreement: true,
            keyCertSign: true,
            cRLSign: true,
            encipherOnly: true,
            decipherOnly: true
        },
        {
            name: 'subjectAltName',
            altNames: [
                {
                    type: 2,
                    value: os.hostname()
                }
            ]
        },
        {
            name: 'subjectKeyIdentifier'
        },
        {
            name: 'extKeyUsage',
            serverAuth: true,
            clientAuth: true,
            codeSigning: false,
            emailProtection: false,
            timeStamping: false
        },
        {
            name: 'authorityKeyIdentifier'
        }
    ]);

    cert.sign(keys.privateKey, forge.md.sha256.create());

    const pem_pkey = pki.privateKeyToPem(keys.privateKey);
    const pem_cert = pki.certificateToPem(cert);

    //console.log(pem_pkey);
    //console.log(pem_cert);

    return {
        defaultPrivate: pem_pkey,
        defaultPublic: pem_cert
    };
}

function makeid(length) {
    let result = '';
    const characters = 'abcdef0123456789';
    const charactersLength = characters.length;
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}

/**
 * Collects information about host and available adapters
 *
 *  Following info will be collected:
 *    - available adapters
 *    - node.js --version
 *    - npm --version
 *
 * @alias getHostInfo
 * @memberof Tools
 * @param {object} objects
 *        <pre><code>
 *            function (err, result) {
 *              adapter.log.debug('Info about host: ' + JSON.stringify(result, null, 2);
 *            }
 *        </code></pre>
 */
async function getHostInfo(objects, callback) {
    const os = require('os');

    if (diskusage !== false) {
        try {
            diskusage = diskusage || require('diskusage');
        } catch {
            diskusage = false;
        }
    }

    const cpus = os.cpus();
    const dateObj = new Date();

    const data = {
        Platform: isDocker() ? 'docker' : os.platform(),
        os: process.platform,
        Architecture: os.arch(),
        CPUs: cpus && Array.isArray(cpus) ? cpus.length : null,
        Speed: cpus && Array.isArray(cpus) ? cpus[0].speed : null,
        Model: cpus && Array.isArray(cpus) ? cpus[0].model : null,
        RAM: os.totalmem(),
        'System uptime': Math.round(os.uptime()),
        'Node.js': process.version,
        time: dateObj.getTime(), // give infos to compare the local times
        timeOffset: dateObj.getTimezoneOffset()
    };

    if (data.Platform === 'win32') {
        data.Platform = 'Windows';
    } else if (data.Platform === 'darwin') {
        data.Platform = 'OSX';
    }

    const systemConfig = await objects.getObjectAsync('system.config');
    const systemRepos = await objects.getObjectAsync('system.repositories');

    // Check if repositories exists
    const allRepos = {};
    if (systemRepos && systemRepos.native && systemRepos.native.repositories) {
        const repos = Array.isArray(systemConfig.common.activeRepo)
            ? systemConfig.common.activeRepo
            : [systemConfig.common.activeRepo];
        repos
            .filter(repo => systemRepos.native.repositories[repo] && systemRepos.native.repositories[repo].json)
            .forEach(repo => Object.assign(allRepos, systemRepos.native.repositories[repo].json));

        data['adapters count'] = Object.keys(allRepos).length;
    }

    if (!npmVersion) {
        try {
            const version = await getSystemNpmVersionAsync();
            data['NPM'] = 'v' + (version || ' ---');
            npmVersion = version;
        } catch (e) {
            console.error('Cannot get NPM version: ' + e);
        }
    } else {
        data['NPM'] = npmVersion;
    }
    try {
        const info = await getDiskInfoAsync(data.Platform);
        if (info) {
            Object.assign(data, info);
        }
    } catch (e) {
        console.error('Cannot get disk information: ' + e);
    }
    callback && callback(data);

    return data;
}

/**
 * Finds the controller root directory
 * @returns {string}
 */
function getControllerDir() {
    const possibilities = ['iobroker.js-controller', 'ioBroker.js-controller'];
    for (const pkg of possibilities) {
        try {
            // package.json is guaranteed to be in the module root folder
            // so once that is resolved, take the dirname and we're done
            const possiblePath = require.resolve(`${pkg}/package.json`);
            if (fs.existsSync(possiblePath)) {
                return path.dirname(possiblePath);
            }
        } catch {
            /* not found */
        }
    }

    // Apparently, checking vs null/undefined may miss the odd case of controllerPath being ""
    // Thus we check for falsyness, which includes failing on an empty path
    let checkPath = path.join(__dirname, '../..');
    // Also check in the current check dir (along with iobroker.js-controller subdirs)
    possibilities.unshift('');
    while (true) {
        for (const pkg of possibilities) {
            try {
                const possiblePath = path.join(checkPath, pkg);
                if (fs.existsSync(path.join(possiblePath, 'iob.bat'))) {
                    return possiblePath;
                }
            } catch {
                // not found, continue with next possiblity
            }
        }

        // Controller not found here - go to the parent dir
        const newPath = path.dirname(checkPath);
        if (newPath === checkPath) {
            // We already reached the root dir, abort
            break;
        }
        checkPath = newPath;
    }
}

// All paths are returned always relative to /node_modules/' + module.exports.appName + '.js-controller
// the result has always "/" as last symbol
function getDefaultDataDir() {
    if (fs.existsSync(__dirname + '/../../../../packages/controller')) {
        // dev install
        return './data/';
    }

    const appName = module.exports.appName.toLowerCase();

    // if debugging with npm5
    if (fs.existsSync(__dirname + '/../../node_modules/' + appName + '.js-controller')) {
        return '../' + appName + '-data/';
    } else {
        // If installed with npm
        return '../../' + appName + '-data/';
    }
}

/**
 * Returns the path of the config file
 *
 * @returns {string}
 */
function getConfigFileName() {
    /** @type {string|string[]} */
    let configDir = __dirname.replace(/\\/g, '/');
    configDir = configDir.split('/');
    const appName = module.exports.appName.toLowerCase();

    if (fs.existsSync(__dirname + '/../../../../packages/controller')) {
        // dev install -> Remove /lib
        configDir.splice(configDir.length - 3, 3);
        configDir = configDir.join('/');
        configDir += '/controller'; // go inside controller dir
        if (fs.existsSync(`${configDir}/conf/${appName}.json`)) {
            return `${configDir}/conf/${appName}.json`;
        } else {
            return `${configDir}/data/${appName}.json`;
        }
    }

    // if debugging with npm5 -> node_modules on e.g. /opt/node_modules
    if (
        fs.existsSync(`${__dirname}/../../../../../../../node_modules/${appName.toLowerCase()}.js-controller`) ||
        fs.existsSync(`${__dirname}/../../../../../../../node_modules/${appName}.js-controller`)
    ) {
        // remove /node_modules/' + appName + '.js-controller/lib
        configDir.splice(configDir.length - 7, 7);
        configDir = configDir.join('/');
    } else {
        // If installed with npm -> remove node_modules/@iobroker/js-controller-common/lib/common
        configDir.splice(configDir.length - 5, 5);
        configDir = configDir.join('/');
    }

    return `${configDir}/${appName}-data/${appName}.json`;
}

/**
 * Puts all values from an `arguments` object into an array, starting at the given index
 * @param {IArguments} argsObj An `arguments` object as passed to a function
 * @param {number} [startIndex=0] The optional index to start taking the arguments from
 */
function sliceArgs(argsObj, startIndex) {
    if (startIndex === null || startIndex === undefined) {
        startIndex = 0;
    }
    const ret = [];
    for (let i = startIndex; i < argsObj.length; i++) {
        ret.push(argsObj[i]);
    }
    return ret;
}

/**
 * Promisifies a function which returns an error as the first argument in its callback
 * @param {Function} fn The function to promisify
 * @param {any} [context=this] (optional) The context (value of `this` to bind the function to)
 * @param {string[]} [returnArgNames] (optional) If the callback contains multiple arguments,
 * you can combine them into one object by passing the names as an array.
 * Otherwise the Promise will resolve with an array
 * @returns {(...args: any[]) => Promise<any>}
 */
function promisify(fn, context, returnArgNames) {
    return function () {
        const args = sliceArgs(arguments);
        // @ts-ignore we cannot know the type of `this`
        context = context || this;
        return new Promise((resolve, reject) => {
            fn.apply(
                context,
                args.concat([
                    function (error, result) {
                        if (error) {
                            return reject(error instanceof Error ? error : new Error(error));
                        } else {
                            // decide on how we want to return the callback arguments
                            switch (arguments.length) {
                                case 1: // only an error was given
                                    return resolve(); // Promise<void>
                                case 2: // a single value (result) was returned
                                    return resolve(result);
                                default: {
                                    // multiple values should be returned
                                    /** @type {{} | any[]} */
                                    let ret;
                                    const extraArgs = sliceArgs(arguments, 1);
                                    if (returnArgNames && returnArgNames.length === extraArgs.length) {
                                        // we can build an object
                                        ret = {};
                                        for (let i = 0; i < returnArgNames.length; i++) {
                                            ret[returnArgNames[i]] = extraArgs[i];
                                        }
                                    } else {
                                        // we return the raw array
                                        ret = extraArgs;
                                    }
                                    return resolve(ret);
                                }
                            }
                        }
                    }
                ])
            );
        });
    };
}

/**
 * Promisifies a function which does not provide an error as the first argument in its callback
 * @param {Function} fn The function to promisify
 * @param {any} [context] (optional) The context (value of `this` to bind the function to)
 * @param {string[]} [returnArgNames] (optional) If the callback contains multiple arguments,
 * you can combine them into one object by passing the names as an array.
 * Otherwise the Promise will resolve with an array
 * @returns {(...args: any[]) => Promise<any>}
 */
function promisifyNoError(fn, context, returnArgNames) {
    return function () {
        const args = sliceArgs(arguments);
        // @ts-ignore we cannot know the type of `this`
        context = context || this;
        return new Promise((resolve, _reject) => {
            fn.apply(
                context,
                args.concat([
                    function (result) {
                        // decide on how we want to return the callback arguments
                        switch (arguments.length) {
                            case 0: // no arguments were given
                                return resolve(); // Promise<void>
                            case 1: // a single value (result) was returned
                                return resolve(result);
                            default: {
                                // multiple values should be returned
                                /** @type {{} | any[]} */
                                let ret;
                                const extraArgs = sliceArgs(arguments, 0);
                                if (returnArgNames && returnArgNames.length === extraArgs.length) {
                                    // we can build an object
                                    ret = {};
                                    for (let i = 0; i < returnArgNames.length; i++) {
                                        ret[returnArgNames[i]] = extraArgs[i];
                                    }
                                } else {
                                    // we return the raw array
                                    ret = extraArgs;
                                }
                                return resolve(ret);
                            }
                        }
                    }
                ])
            );
        });
    };
}

/**
 * Creates and executes an array of promises in sequence
 * @param {((...args: any[]) => Promise<any>)[]} promiseFactories An array of promise-returning functions
 */
function promiseSequence(promiseFactories) {
    return promiseFactories.reduce((promise, factory) => {
        return promise.then(result => factory().then(Array.prototype.concat.bind(result)));
    }, Promise.resolve([]));
}

function _setQualityForStates(states, keys, quality, cb) {
    if (!keys || !states || !keys.length) {
        cb();
    } else {
        states.setState(
            keys.shift(),
            {
                ack: null,
                q: quality
            },
            () => setImmediate(_setQualityForStates, states, keys, quality, cb)
        );
    }
}

function setQualityForInstance(objects, states, namespace, q) {
    return new Promise((resolve, reject) => {
        objects.getObjectView(
            'system',
            'state',
            {
                startkey: namespace + '.',
                endkey: namespace + '.\u9999',
                include_docs: false
            },
            (err, _states) => {
                if (err) {
                    reject(err);
                } else {
                    let keys = [];
                    if (_states && _states.rows) {
                        for (let s = 0; s < _states.rows.length; s++) {
                            const id = _states.rows[s].id;
                            // if instance still active, but device is offline
                            if (!(q & 0x10) && id.match(/\.info\.connection$/)) {
                                continue;
                            }
                            keys.push(id);
                        }
                    }
                    // read all values for IDs
                    states.getStates(keys, (_err, values) => {
                        // Get only states, that have ack = true
                        keys = keys.filter((_id, i) => values[i] && values[i].ack);
                        // update quality code of the states to new one
                        _setQualityForStates(states, keys, q, err => (err ? reject(err) : resolve()));
                    });
                }
            }
        );
    });
}

/**
 * Converts ioB pattern into regex.
 * @param {string} pattern - Regex string to use it in new RegExp(pattern)
 * @returns {string}
 */
function pattern2RegEx(pattern) {
    pattern = (pattern || '').toString();

    const startsWithWildcard = pattern[0] === '*';
    const endsWithWildcard = pattern[pattern.length - 1] === '*';

    pattern = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*');

    return (startsWithWildcard ? '' : '^') + pattern + (endsWithWildcard ? '' : '$');
}

/**
 * Generates a stack trace that can be added to log outputs to trace their source
 * @param {string} [wrapperName = 'captureStackTrace'] The wrapper function after which the stack trace should begin
 * @returns {string}
 */
function captureStackTrace(wrapperName) {
    if (typeof wrapperName !== 'string') {
        wrapperName = 'captureStackTrace';
    }

    const ret = new Error();
    if (ret.stack) {
        let foundSelf = false;
        const lines = ret.stack.split('\n').filter(line => {
            // keep all lines after this function's
            if (foundSelf) {
                return true;
            }
            if (line.includes(wrapperName)) {
                foundSelf = true;
            }
            return false;
        });
        return lines.join('\n');
    }
    return '';
}

/**
 * Appends the stack trace generated by `captureStackTrace` to the given string
 * @param {string} str - The string to append the stack trace to
 * @returns {string}
 */
function appendStackTrace(str) {
    // Convert anything that isn't a string into a string
    if (typeof str !== 'string') {
        str = String(str);
    }
    if (str.substr(-1) !== '\n') {
        str += '\n';
    }
    return str + captureStackTrace('appendStackTrace');
}

/**
 * Encrypt the password/value with given key
 * @param {string} key - Secret key
 * @param {string} value - value to encrypt
 * @returns {string}
 */
function encryptLegacy(key, value) {
    let result = '';
    for (let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

/**
 * Decrypt the password/value with given key
 * @param {string} key - Secret key
 * @param {string} value - value to decrypt
 * @returns {string}
 */
function decryptLegacy(key, value) {
    let result = '';
    for (let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

/**
 * encrypts a value by a given key via AES-192-CBC
 *
 * @param {string} key - Secret key
 * @param {string} value - value to decrypt
 * @returns {string}
 */
function encrypt(key, value) {
    if (!/^[0-9a-f]{48}$/.test(key)) {
        // key length is not matching for AES-192-CBC or key is no valid hex - fallback to old encryption
        return encryptLegacy(key, value);
    }

    crypto = crypto || require('crypto');

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-192-cbc', Buffer.from(key, 'hex'), iv);

    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);

    return `$/aes-192-cbc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * encrypts a value by a given key via AES-192-CBC
 *
 * @param {string} key - Secret key
 * @param {string} value - value to decrypt
 * @returns {string}
 */
function decrypt(key, value) {
    // if not encrypted as aes-192 or key not a valid 48 digit hex -> fallback
    if (!value.startsWith(`$/aes-192-cbc:`) || !/^[0-9a-f]{48}$/.test(key)) {
        return decryptLegacy(key, value);
    }

    crypto = crypto || require('crypto');

    const textParts = value.split(':');
    const iv = Buffer.from(textParts[1], 'hex');
    const encryptedText = Buffer.from(textParts.pop(), 'hex');
    const decipher = crypto.createDecipheriv('aes-192-cbc', Buffer.from(key, 'hex'), iv);

    const decrypted = Buffer.concat([decipher.update(encryptedText), decipher.final()]);

    return decrypted.toString();
}

/**
 * Tests whether the given variable is a real object and not an Array
 * @param {any} it The variable to test
 * @returns {it is Record<string, any>}
 */
function isObject(it) {
    // This is necessary because:
    // typeof null === 'object'
    // typeof [] === 'object'
    // [] instanceof Object === true
    return Object.prototype.toString.call(it) === '[object Object]'; // this code is 25% faster then below one
    // return it && typeof it === 'object' && !(it instanceof Array);
}

/**
 * Tests whether the given variable is really an Array
 * @param {any} it The variable to test
 */
function isArray(it) {
    return Array.isArray(it); // from node 0.1 is a part of engine
}

/**
 * Measure the Node.js event loop lag and repeatedly call the provided callback function with the updated results
 * @param {number} ms The number of milliseconds for monitoring
 * @param {function} cb Callback function to call for each new value
 */
function measureEventLoopLag(ms, cb) {
    let start = hrtime();

    let timeout = setTimeout(check, ms);
    timeout.unref();

    function check() {
        // workaround for https://github.com/joyent/node/issues/8364
        clearTimeout(timeout);

        // how much time has actually elapsed in the loop beyond what
        // setTimeout says is supposed to happen. we use setTimeout to
        // cover multiple iterations of the event loop, getting a larger
        // sample of what the process is working on.
        const t = hrtime();

        // we use Math.max to handle case where timers are running efficiently
        // and our callback executes earlier than `ms` due to how timers are
        // implemented. this is ok. it means we're healthy.
        cb && cb(Math.max(0, t - start - ms));
        start = t;

        timeout = setTimeout(check, ms);
        timeout.unref();
    }

    function hrtime() {
        const t = process.hrtime();
        return t[0] * 1e3 + t[1] / 1e6;
    }
}

/**
 * This function convert state values by read and write of aliases. Function is synchron.
 *
 * @param {object} sourceObj
 * @param {object} targetObj
 * @param {object} state Object with val, ack and so on
 * @param {object} logger Logging object
 * @param {string} logNamespace optional Logging namespace
 */
function formatAliasValue(sourceObj, targetObj, state, logger, logNamespace) {
    logNamespace = logNamespace ? logNamespace + ' ' : '';

    if (!state) {
        return;
    }
    if (state.val === undefined) {
        state.val = null;
        return state;
    }

    if (targetObj && targetObj.alias && targetObj.alias.read) {
        try {
            // process the value here
            const func = new Function(
                'val',
                'type',
                'min',
                'max',
                'sType',
                'sMin',
                'sMax',
                'return ' + targetObj.alias.read
            );
            state.val = func(
                state.val,
                targetObj.type,
                targetObj.min,
                targetObj.max,
                sourceObj.type,
                sourceObj.min,
                sourceObj.max
            );
        } catch (e) {
            logger.error(
                `${logNamespace} Invalid read function for ${targetObj._id}: ${targetObj.alias.read} => ${e.message}`
            );
            return null;
        }
    }

    if (sourceObj && sourceObj.alias && sourceObj.alias.write) {
        try {
            // process the value here
            const func = new Function(
                'val',
                'type',
                'min',
                'max',
                'tType',
                'tMin',
                'tMax',
                'return ' + sourceObj.alias.write
            );
            state.val = func(
                state.val,
                sourceObj.type,
                sourceObj.min,
                sourceObj.max,
                targetObj.type,
                targetObj.min,
                targetObj.max
            );
        } catch (e) {
            logger.error(
                `${logNamespace} Invalid write function for ${sourceObj._id}: ${sourceObj.alias.write} => ${e.message}`
            );
            return null;
        }
    }

    if (targetObj && typeof state.val !== targetObj.type && state.val !== null) {
        if (targetObj.type === 'boolean') {
            const lowerVal = typeof state.val === 'string' ? state.val.toLowerCase() : state.val;
            if (lowerVal === 'off' || lowerVal === 'aus' || state.val === '0') {
                state.val = false;
            } else {
                // this also handles strings like "EIN" or such that will be true
                state.val = !!state.val;
            }
        } else if (targetObj.type === 'number') {
            state.val = parseFloat(state.val);
        } else if (targetObj.type === 'string') {
            state.val = state.val.toString();
        }
    }

    // auto-scaling, only if val not null and unit for target (x)or source is %
    if (
        ((targetObj && targetObj.alias && !targetObj.alias.read) ||
            (sourceObj && sourceObj.alias && !sourceObj.alias.write)) &&
        state.val !== null
    ) {
        if (
            targetObj &&
            targetObj.type === 'number' &&
            targetObj.unit === '%' &&
            sourceObj &&
            sourceObj.type === 'number' &&
            sourceObj.unit !== '%' &&
            sourceObj.min !== undefined &&
            sourceObj.max !== undefined
        ) {
            // scale target between 0 and 100 % based on sources min/max
            state.val = ((state.val - sourceObj.min) / (sourceObj.max - sourceObj.min)) * 100;
        } else if (
            sourceObj &&
            sourceObj.type === 'number' &&
            sourceObj.unit === '%' &&
            targetObj &&
            targetObj.unit !== '%' &&
            targetObj.type === 'number' &&
            targetObj.min !== undefined &&
            targetObj.max !== undefined
        ) {
            // scale target based on its min/max by its source (assuming source is meant to be 0 - 100 %)
            state.val = ((targetObj.max - targetObj.min) * state.val) / 100 + targetObj.min;
        }
    }

    return state;
}

/**
 * remove given id from all enums
 *
 * @alias removeIdFromAllEnums
 * @memberof tools
 * @param {object} objects object to access objects db
 * @param {string} id the object id which will be deleted from enums
 * @param {object} [allEnums] objects with all enums to use - if not provided all enums will be queried
 * @returns {Promise} All objects are tried to be updated - reject will happen as soon as one fails with the error of the first fail
 *
 */
async function removeIdFromAllEnums(objects, id, allEnums) {
    if (!allEnums) {
        allEnums = await this.getAllEnums(objects);
    }

    let error = null;
    for (const [enumId, enumObj] of Object.entries(allEnums)) {
        const idx = enumObj.common.members ? enumObj.common.members.indexOf(id) : -1;
        if (idx !== -1) {
            // the id is in the enum now we have to remove it
            enumObj.common.members.splice(idx, 1);
            try {
                await objects.setObjectAsync(enumId, enumObj);
                // update cache directly to prevent race conditions when sending many delete in a short time
                allEnums[enumId] = enumObj;
            } catch (err) {
                if (!error) {
                    error = err;
                }
            }
        }
    }
    if (error) {
        throw error;
    }
}

/**
 * Parses dependencies to standardized object of form
 *
 * @alias parseDependencies
 * @memberof tools
 * @param {string[]|Record<string, string>[]|string|Record<string, string>} dependencies dependencies array or single dependency
 * @returns {Record<string, string>} parsed dependencies
 */
function parseDependencies(dependencies) {
    let adapters = {};
    if (Array.isArray(dependencies)) {
        dependencies.forEach(rule => {
            if (typeof rule === 'string') {
                // No version given, all are okay
                adapters[rule] = '*';
            } else if (isObject(rule)) {
                // can be object containing single adapter or multiple
                Object.keys(rule)
                    .filter(adapter => !adapters[adapter])
                    .forEach(adapter => (adapters[adapter] = rule[adapter]));
            }
        });
    } else if (typeof dependencies === 'string') {
        // its a single string without version requirement
        adapters[dependencies] = '*';
    } else if (isObject(dependencies)) {
        // if dependencies is already an object, just use it
        adapters = dependencies;
    }
    return adapters;
}

/**
 * Validates types of obj.common properties and object.type, if invalid types are used, an error is thrown.
 * If attributes of obj.common are not provided, no error is thrown. obj.type has to be there and has to be valid.
 *
 * @param {object} obj an object which will be validated
 * @param {boolean} [extend] (optional) if true checks will allow more optional cases for extendObject calls
 * @throws Error if a property has the wrong type or obj.type is non existing
 */
function validateGeneralObjectProperties(obj, extend) {
    // designs have no type but have attribute views
    if (obj && obj.type === undefined && obj.views !== undefined) {
        return;
    }

    if (!obj || (obj.type === undefined && !extend)) {
        throw new Error(`obj.type has to exist`);
    }

    if (obj.type !== undefined && typeof obj.type !== 'string') {
        throw new Error(`obj.type has an invalid type! Expected "string", received "${typeof obj.type}"`);
    }

    const allowedObjectTypes = [
        'state',
        'channel',
        'device',
        'enum',
        'host',
        'adapter',
        'instance',
        'meta',
        'config',
        'script',
        'user',
        'group',
        'chart',
        'folder'
    ];
    if (obj.type !== undefined && !allowedObjectTypes.includes(obj.type)) {
        throw new Error(
            `obj.type has an invalid value (${obj.type}) but has to be one of ${allowedObjectTypes.join(', ')}`
        );
    }

    // obj.common is optional in general check
    if (!obj.common) {
        return;
    }

    if (obj.common.name !== undefined && typeof obj.common.name !== 'string' && typeof obj.common.name !== 'object') {
        throw new Error(
            `obj.common.name has an invalid type! Expected "string" or "object", received "${typeof obj.common.name}"`
        );
    } else if (['adapter'].includes(obj.type) && typeof obj.common.name !== 'string') {
        // TODO: we need this for group/user too, but have to solve problems described in #1266
        // for some types, name needs to be a unique string
        throw new Error(`obj.common.name has an invalid type! Expected "string", received "${typeof obj.common.name}"`);
    }

    if (obj.common.type !== undefined) {
        if (typeof obj.common.type !== 'string') {
            throw new Error(
                `obj.common.type has an invalid type! Expected "string", received "${typeof obj.common.type}"`
            );
        }

        if (obj.type === 'state') {
            // if object type indicates a state, check that common.type matches
            const allowedStateTypes = ['number', 'string', 'boolean', 'array', 'object', 'mixed', 'file', 'json'];
            if (!allowedStateTypes.includes(obj.common.type)) {
                throw new Error(
                    `obj.common.type has an invalid value (${
                        obj.common.type
                    }) but has to be one of ${allowedStateTypes.join(', ')}`
                );
            }

            // ensure that min max only exists for common.type number and is number itself
            if (obj.common.min !== undefined) {
                if (typeof obj.common.min !== 'number') {
                    throw new Error(
                        `obj.common.min has an invalid type! Expected "number", received "${typeof obj.common.min}"`
                    );
                }

                if (obj.common.type !== 'number') {
                    throw new Error(
                        `obj.common.min is only allowed on obj.common.type "number", received "${obj.common.type}"`
                    );
                }
            }

            if (obj.common.max !== undefined) {
                if (typeof obj.common.max !== 'number') {
                    throw new Error(
                        `obj.common.max has an invalid type! Expected "number", received "${typeof obj.common.max}"`
                    );
                }

                if (obj.common.type !== 'number') {
                    throw new Error(
                        `obj.common.max is only allowed on obj.common.type "number", received "${obj.common.type}"`
                    );
                }

                if (obj.common.min !== undefined && obj.common.min > obj.common.max) {
                    throw new Error(
                        `obj.common.min (${obj.common.min}) needs to be less than or equal to obj.common.max (${obj.common.max})`
                    );
                }
            }

            // ensure, that default value has correct type
            if (obj.common.def !== undefined && obj.common.def !== null) {
                if (obj.common.type === 'file') {
                    // defaults are set via setState but would need setBinaryState
                    throw new Error('Default value is not supported for type "file"');
                }

                // else do what strictObjectChecks does for val
                if (
                    !(
                        (obj.common.type === 'mixed' && typeof obj.common.def !== 'object') ||
                        (obj.common.type !== 'object' && obj.common.type === typeof obj.common.def) ||
                        (obj.common.type === 'array' && typeof obj.common.def === 'string') ||
                        (obj.common.type === 'json' && typeof obj.common.def === 'string') ||
                        (obj.common.type === 'file' && typeof obj.common.def === 'string') ||
                        (obj.common.type === 'object' && typeof obj.common.def === 'string')
                    )
                ) {
                    // types can be 'number', 'string', 'boolean', 'array', 'object', 'mixed', 'file', 'json'
                    // array, object, json need to be string
                    if (['object', 'json', 'file', 'array'].includes(obj.common.type)) {
                        throw new Error(
                            `Default value has to be stringified but received type "${typeof obj.common.def}"`
                        );
                    } else {
                        throw new Error(
                            `Default value has to be ${
                                obj.common.type === 'mixed'
                                    ? `one of type "string", "number", "boolean"`
                                    : `type "${obj.common.type}"`
                            } but received type "${typeof obj.common.def}"`
                        );
                    }
                }
            }
        }
    }

    if (obj.common.read !== undefined && typeof obj.common.read !== 'boolean') {
        throw new Error(
            `obj.common.read has an invalid type! Expected "boolean", received "${typeof obj.common.read}"`
        );
    }

    if (obj.common.write !== undefined && typeof obj.common.write !== 'boolean') {
        throw new Error(
            `obj.common.write has an invalid type! Expected "boolean", received "${typeof obj.common.write}"`
        );
    }

    if (obj.common.role !== undefined && typeof obj.common.role !== 'string') {
        throw new Error(`obj.common.role has an invalid type! Expected "string", received "${typeof obj.common.role}"`);
    }

    if (obj.common.desc !== undefined && typeof obj.common.desc !== 'string' && typeof obj.common.desc !== 'object') {
        throw new Error(
            `obj.common.desc has an invalid type! Expected "string" or "object", received "${typeof obj.common.desc}"`
        );
    }

    if (
        obj.type === 'state' &&
        obj.common.custom !== undefined &&
        obj.common.custom !== null &&
        !isObject(obj.common.custom)
    ) {
        throw new Error(
            `obj.common.custom has an invalid type! Expected "object", received "${typeof obj.common.custom}"`
        );
    }

    // common.states needs to be a real object or an array
    if (obj.common.states !== undefined && !isObject(obj.common.states) && !Array.isArray(obj.common.states)) {
        throw new Error(
            `obj.common.states has an invalid type! Expected "object", received "${typeof obj.common.states}"`
        );
    }
}

/**
 * get all instances of all adapters in the list
 *
 * @alias getAllInstances
 * @memberof tools
 * @param {string[]} adapters list of adapter names to get instances for
 * @param {object} objects class redis objects
 * @returns {Promise<string[]>} - array of IDs
 */
async function getAllInstances(adapters, objects) {
    const instances = [];

    for (let i = 0; i < adapters.length; i++) {
        if (!adapters[i]) {
            continue;
        }
        if (!adapters[i].includes('.')) {
            const inst = await getInstances(adapters[i], objects, false);
            for (let j = 0; j < inst.length; j++) {
                if (!instances.includes(inst[j])) {
                    instances.push(inst[j]);
                }
            }
        } else {
            if (!instances.includes(adapters[i])) {
                instances.push(adapters[i]);
            }
        }
    }

    return instances;
}

/**
 * Get all existing enums
 *
 * @param {object} objects - objects db
 * @returns {Promise<{}>}
 */
async function getAllEnums(objects) {
    const allEnums = {};
    const res = await objects.getObjectViewAsync('system', 'enum', {
        startkey: 'enum.',
        endkey: 'enum.\u9999'
    });
    if (res && res.rows) {
        for (const row of res.rows) {
            allEnums[row.id] = row.value;
        }
    }

    return allEnums;
}

/**
 * get async all instances of one adapter
 *
 * @alias getInstances
 * @param {string} adapter name of the adapter
 * @param {object}objects objects DB
 * @param {boolean} withObjects return objects instead of only ids
 */
async function getInstances(adapter, objects, withObjects) {
    const arr = await objects.getObjectListAsync({
        startkey: 'system.adapter.' + adapter + '.',
        endkey: 'system.adapter.' + adapter + '.\u9999'
    });
    const instances = [];
    if (arr && arr.rows) {
        for (let i = 0; i < arr.rows.length; i++) {
            if (arr.rows[i].value.type !== 'instance') {
                continue;
            }
            if (withObjects) {
                instances.push(arr.rows[i].value);
            } else {
                instances.push(arr.rows[i].value._id);
            }
        }
    }

    return instances;
}

/**
 * Checks if the given callback is a function and if so calls it with the given parameter immediately, else a resolved Promise is returned
 *
 * @param {(...args: any[]) => void | null | undefined} callback - callback function to be executed
 * @param {...any} args - as many arguments as needed, which will be returned by the callback function or by the Promise
 * @returns {Promise<any>} - if Promise is resolved with multiple arguments, an array is returned
 */
function maybeCallback(callback, ...args) {
    if (typeof callback === 'function') {
        // if function we call it with given param
        setImmediate(callback, ...args);
    } else {
        return Promise.resolve(args.length > 1 ? args : args[0]);
    }
}

/**
 * Checks if the given callback is a function and if so calls it with the given error and parameter immediately, else a resolved or rejected Promise is returned. Error ERROR_DB_CLOSED are not rejecting the promise
 *
 * @param {((error: Error | null | undefined, ...args: any[]) => void) | null | undefined} callback - callback function to be executed
 * @param {Error | string | null | undefined} error - error which will be used by the callback function. If callback is not a function and
 * error is given, a rejected Promise is returned. If error is given but it is not an instance of Error, it is converted into one.
 * @param {...any} args - as many arguments as needed, which will be returned by the callback function or by the Promise
 * @returns {Promise<any>} - if Promise is resolved with multiple arguments, an array is returned
 */
function maybeCallbackWithError(callback, error, ...args) {
    if (error !== undefined && error !== null && !(error instanceof Error)) {
        // if it's not a real Error, we convert it into one
        error = new Error(error);
    }
    const isDbError = error ? error.message === ERROR_DB_CLOSED : false;

    if (typeof callback === 'function') {
        setImmediate(callback, error, ...args);
    } else if (error && !isDbError) {
        return Promise.reject(error);
    } else {
        return Promise.resolve(args.length > 1 ? args : args[0]);
    }
}

/**
 * Executes a command asynchronously. On success, the promise resolves with stdout and stderr.
 * On error, the promise rejects with the exit code or signal, as well as stdout and stderr.
 * @param {string} command The command to execute
 * @param {import('child_process').ExecOptions} [execOptions] The options for child_process.exec
 * @returns {import('child_process').ChildProcess & Promise<{stdout?: string; stderr?: string}>}
 */
function execAsync(command, execOptions) {
    const defaultOptions = {
        // we do not want to show the node.js window on Windows
        windowsHide: true,
        // And we want to capture stdout/stderr
        encoding: 'utf8'
    };
    // @ts-ignore We set the encoding, so stdout/stdrr must be a string
    return cpPromise.exec(command, { ...defaultOptions, ...execOptions });
}

/**
 * Takes input from one stream and writes it to another as soon as a complete line was read.
 * @param {NodeJS.ReadableStream} input The stream to read from
 * @param {NodeJS.WritableStream} output The stream to write into
 */
function pipeLinewise(input, output) {
    const rl = createInterface({
        input,
        crlfDelay: Infinity
    });
    rl.on('line', line => output.write(line + os.EOL));
}

/**
 * Find the adapter main file as full path
 *
 * @memberof tools
 * @param {string} adapter - adapter name of the adapter, e.g. hm-rpc
 * @returns {Promise<string>}
 */
async function resolveAdapterMainFile(adapter) {
    const adapterDir = getAdapterDir(adapter);
    if (!adapterDir) {
        throw new Error(`Could not find adapter dir of ${adapter}`);
    }

    const possibleMainFiles = ['main.js', `${adapter}.js`];

    // Add package.json -> main as the 2nd choice
    try {
        const pack = JSON.parse(await fs.readFile(path.join(adapterDir, 'package.json'), 'utf8'));
        if (pack && typeof pack.main === 'string') {
            possibleMainFiles.unshift(pack.main);
        }
    } catch {
        // Ignore, we have fallback solutions
    }

    // Add io-package.json -> common.main as the preferred choice
    try {
        const ioPack = JSON.parse(await fs.readFile(path.join(adapterDir, 'io-package.json'), 'utf8'));
        if (ioPack && ioPack.common && typeof ioPack.common.main === 'string') {
            possibleMainFiles.unshift(ioPack.common.main);
        }
    } catch {
        // Ignore, we have fallback solutions
    }

    // Try all possible main files
    for (const mainFile of possibleMainFiles) {
        const fullFileName = path.join(adapterDir, mainFile);
        if (await fs.pathExists(fullFileName)) {
            return fullFileName;
        }
    }

    throw new Error(`Could not find main file of ${adapter}`);
}

/**
 * Returns the default nodeArgs required to execute the main file, e.g. transpile hooks for TypeScript
 * @param {string} mainFile
 * @returns {string[]}
 */
function getDefaultNodeArgs(mainFile) {
    if (mainFile.endsWith('.ts')) {
        return ['-r', '@alcalzone/esbuild-register'];
    }
    return [];
}

/** This is used for the short github URL format that NPM accepts (<githubname>/<githubrepo>[#<commit-ish>]) */
const shortGithubUrlRegex = /^(?<user>[^/]+)\/(?<repo>[^#]+)(?:#(?<commit>.+))?$/;

/**
 * Tests if the given URL matches the format <githubname>/<githubrepo>[#<commit-ish>]
 * @param {string} url The URL to parse
 */
function isShortGithubUrl(url) {
    return shortGithubUrlRegex.test(url);
}

/**
 * Tries to parse an URL in the format <githubname>/<githubrepo>[#<commit-ish>] into its separate parts
 * @param {string} url The URL to parse
 * @returns {{user: string; repo: string; commit?: string} | null}
 */
function parseShortGithubUrl(url) {
    const match = shortGithubUrlRegex.exec(url);
    if (!match || !match.groups) {
        return null;
    }
    return {
        user: match.groups.user,
        repo: match.groups.repo,
        commit: match.groups.commit
    };
}

/** This is used to parse the pathname of a github URL */
const githubPathnameRegex =
    /^\/(?<user>[^/]+)\/(?<repo>[^/]*?)(?:\.git)?(?:\/(?:tree|tarball|archive)\/(?<commit>.*?)(?:\.(?:zip|gz|tar\.gz))?)?$/;

/**
 * Tests if the given pathname matches the format /<githubname>/<githubrepo>[.git][/<tarball|tree|archive>/<commit-ish>[.zip|.gz]]
 * @param {string} pathname The pathname part of a Github URL
 */
function isGithubPathname(pathname) {
    return githubPathnameRegex.test(pathname);
}

/**
 * Tries to a github pathname format /<githubname>/<githubrepo>[.git][/<tarball|tree|archive>/<commit-ish>[.zip|.gz|.tar.gz]] into its separate parts
 * @param {string} pathname The pathname part of a Github URL
 * @returns {{user: string; repo: string; commit: string} | null}
 */
function parseGithubPathname(pathname) {
    const match = githubPathnameRegex.exec(pathname);
    if (!match || !match.groups) {
        return null;
    }
    return {
        user: match.groups.user,
        repo: match.groups.repo,
        commit: match.groups.commit
    };
}

/**
 * Removes properties which are given by preserve
 * @param {object} preserve - object which has true entries (or array of selected attributes) for all attributes which should be removed from currObj
 * @param {object} oldObj - old object
 * @param {object} newObj - new object
 */
function removePreservedProperties(preserve, oldObj, newObj) {
    for (const prop of Object.keys(preserve)) {
        if (isObject(preserve[prop]) && isObject(newObj[prop])) {
            // we have to go one step deeper
            removePreservedProperties(preserve[prop], oldObj[prop], newObj[prop]);
        } else if (newObj && newObj[prop] !== undefined && oldObj && oldObj[prop] !== undefined) {
            // we only need to remove something if its in the old object and in the new one
            if (typeof preserve[prop] === 'boolean') {
                delete newObj[prop];
            } else if (Array.isArray(preserve[prop])) {
                // array, only rm selected subattributes instead of whole attribute
                for (const rmProp of preserve[prop]) {
                    if (oldObj[prop][rmProp] !== undefined && newObj[prop][rmProp] !== undefined) {
                        // only delete if conflicting
                        delete newObj[prop][rmProp];
                    }
                }
            }
        }
    }
}

/**
 * Returns the array of system.adapter.<namespace>.* objects which are created for every instance
 *
 * @param {string} namespace - adapter namespace + id, e.g. hm-rpc.0
 * @param {boolean} createWakeup - indicator to create wakeup object too
 * @returns {object[]}
 */
function getInstanceIndicatorObjects(namespace, createWakeup) {
    const id = `system.adapter.${namespace}`;
    const objs = [
        {
            _id: `${id}.alive`,
            type: 'state',
            common: {
                name: `${namespace} alive`,
                type: 'boolean',
                read: true,
                write: true,
                role: 'indicator.state'
            },
            native: {}
        },
        {
            _id: `${id}.connected`,
            type: 'state',
            common: {
                name: `${namespace} is connected`,
                type: 'boolean',
                read: true,
                write: false,
                role: 'indicator.state'
            },
            native: {}
        },
        {
            _id: `${id}.compactMode`,
            type: 'state',
            common: {
                name: `${namespace}.compactMode`,
                type: 'boolean',
                read: true,
                write: false,
                role: 'indicator.state'
            },
            native: {}
        },
        {
            _id: `${id}.cpu`,
            type: 'state',
            common: {
                name: `${namespace}.cpu`,
                type: 'number',
                read: true,
                write: false,
                role: 'indicator.state',
                unit: '% of one core'
            },
            native: {}
        },
        {
            _id: `${id}.cputime`,
            type: 'state',
            common: {
                name: namespace + '.cputime',
                type: 'number',
                read: true,
                write: false,
                role: 'indicator.state',
                unit: 'seconds'
            },
            native: {}
        },
        {
            _id: `${id}.memHeapUsed`,
            type: 'state',
            common: {
                name: `${namespace} heap actually Used`,
                type: 'number',
                read: true,
                write: false,
                role: 'indicator.state',
                unit: 'MB'
            },
            native: {}
        },
        {
            _id: `${id}.memHeapTotal`,
            type: 'state',
            common: {
                name: `${namespace} total Size of the Heap`,
                read: true,
                write: false,
                type: 'number',
                role: 'indicator.state',
                unit: 'MB'
            },
            native: {}
        },
        {
            _id: `${id}.memRss`,
            type: 'state',
            common: {
                name: `${namespace} resident Set Size`,
                desc: 'Resident set size',
                read: true,
                write: false,
                type: 'number',
                role: 'indicator.state',
                unit: 'MB'
            },
            native: {}
        },
        {
            _id: `${id}.uptime`,
            type: 'state',
            common: {
                name: `${namespace} uptime`,
                type: 'number',
                read: true,
                write: false,
                role: 'indicator.state',
                unit: 'seconds'
            },
            native: {}
        },
        {
            _id: `${id}.inputCount`,
            type: 'state',
            common: {
                name: `${namespace} events input counter`,
                desc: "State's inputs in 15 seconds",
                type: 'number',
                read: true,
                write: false,
                role: 'state',
                unit: 'events/15 seconds'
            },
            native: {}
        },
        {
            _id: `${id}.outputCount`,
            type: 'state',
            common: {
                name: `${namespace} events output counter`,
                desc: "State's outputs in 15 seconds",
                type: 'number',
                read: true,
                write: false,
                role: 'state',
                unit: 'events/15 seconds'
            },
            native: {}
        },
        {
            _id: `${id}.eventLoopLag`,
            type: 'state',
            common: {
                name: `${namespace} Node.js event loop lag`,
                desc: 'Node.js event loop lag in ms averaged over 15 seconds',
                type: 'number',
                read: true,
                write: false,
                role: 'state',
                unit: 'ms'
            },
            native: {}
        },
        {
            _id: `${id}.sigKill`,
            type: 'state',
            common: {
                name: `${namespace} kill signal`,
                type: 'number',
                read: true,
                write: false,
                desc: 'Process id that must survive. All other IDs must terminate itself',
                role: 'state'
            },
            native: {}
        },
        {
            _id: `${id}.logLevel`,
            type: 'state',
            common: {
                name: `${namespace} loglevel`,
                type: 'string',
                read: true,
                write: true,
                desc: 'Loglevel of the adapter. Will be set on start with defined value but can be overridden during runtime',
                role: 'state'
            },
            native: {}
        }
    ];

    if (createWakeup) {
        objs.push({
            _id: `${id}.wakeup`,
            type: 'state',
            common: {
                name: `${namespace}.wakeup`,
                read: true,
                write: true,
                type: 'boolean',
                role: 'adapter.wakeup'
            },
            native: {}
        });
    }

    return objs;
}

function getLogger(log) {
    if (!log) {
        log = {
            silly: function (_msg) {
                /*console.log(msg);*/
            },
            debug: function (_msg) {
                /*console.log(msg);*/
            },
            info: function (_msg) {
                /*console.log(msg);*/
            },
            warn: function (msg) {
                console.log(msg);
            },
            error: function (msg) {
                console.log(msg);
            }
        };
    } else if (!log.silly) {
        log.silly = log.debug;
    }
    return log;
}

/**
 * Get ordered instances according to tier level
 *
 * @param {object} objects - Objects DB
 * @param {object} logger - logger object
 * @param {string} [logPrefix] - prefix for logging
 * @return {Promise<object[]>}
 */
async function getInstancesOrderedByStartPrio(objects, logger, logPrefix = '') {
    const instances = { 1: [], 2: [], 3: [], admin: [] };
    const allowedTiers = [1, 2, 3];

    if (logPrefix) {
        // append space if we have a prefix
        logPrefix += ' ';
    }

    let doc = {};
    try {
        doc = await objects.getObjectViewAsync('system', 'instance', {
            startkey: 'system.adapter.',
            endkey: 'system.adapter.\u9999'
        });
    } catch (e) {
        if (e.message && e.message.startsWith('Cannot find ')) {
            logger.error(`${logPrefix} _design/system missing - call node ${module.exports.appName}.js setup`);
        } else {
            logger.error(`${logPrefix} Can not get instances: ${e.message}`);
        }
    }

    if (!doc.rows || doc.rows.length === 0) {
        logger.info(`${logPrefix} no instances found`);
    } else {
        for (const row of doc.rows) {
            if (row && row.value) {
                if (row.value._id.startsWith('system.adapter.admin')) {
                    instances.admin.push(row.value);
                } else if (row.value.common && allowedTiers.includes(parseInt(row.value.common.tier))) {
                    instances[row.value.common.tier].push(row.value);
                } else {
                    // no valid tier so put it in the last one
                    instances['3'].push(row.value);
                }
            }
        }
    }

    return [...instances.admin, ...instances['1'], ...instances['2'], ...instances['3']];
}

/**
 * Set capabilities of the given executable on Linux systems
 * @param {string} execPath - path to the executable for node you can determine it via process.execPath
 * @param {string[]} capabilities - capabilities to set, e.g. ['cap_net_admin', 'cap_net_bind_service']
 * @param {boolean} [modeEffective] - add effective mode
 * @param {boolean} [modePermitted] - add permitted mode
 * @param {boolean} [modeInherited] - add inherited mode
 * @returns {Promise<void>}
 */
async function setExecutableCapabilities(execPath, capabilities, modeEffective, modePermitted, modeInherited) {
    // if not linux do nothing and silently exit
    if (os.platform() === 'linux') {
        if (Array.isArray(capabilities) && capabilities.length) {
            let modes = '';
            const capabilitiesStr = capabilities.join(',');

            if (modeEffective) {
                modes += 'e';
            }

            if (modePermitted) {
                modes += 'p';
            }

            if (modeInherited) {
                modes += 'i';
            }

            if (modes.length) {
                modes = `+${modes}`;
            }

            // if this throws it needs to be caught outside
            await cpPromise.exec(`sudo setcap ${capabilitiesStr}${modes} ${execPath}`);
        } else {
            throw new Error('No capabilities array provided');
        }
    }
}

/**
 * Requests the licenses from ioBroker.net
 * @param {string} login Login for ioBroker.net
 * @param {string} password Decoded password for ioBroker.net
 * @returns {Promise<object[]>} array of all licenses stored on iobroker.net
 */
async function _readLicenses(login, password) {
    axios = axios || require('axios');
    const config = {
        headers: { Authorization: `Basic ${Buffer.from(login + ':' + password).toString('base64')}` },
        timeout: 4000
    };

    try {
        const response = await axios.get(`https://iobroker.net:3001/api/v1/licenses`, config);
        if (response.data && response.data.length) {
            const now = Date.now();
            response.data = response.data.filter(
                license =>
                    !license.validTill ||
                    license.validTill === '0000-00-00 00:00:00' ||
                    new Date(license.validTill).getTime() > now
            );
        }

        return response.data;
    } catch (err) {
        if (err.response) {
            throw new Error((err.response.data && err.response.data.error) || err.response.data || err.response.status);
        } else if (err.request) {
            throw new Error('no response');
        } else {
            throw err;
        }
    }
}

/**
 * Reads the licenses from iobroker.net
 * Reads the licenses from iobroker.net and if no login/password provided stores it in system.licenses
 * @param {object} objects Object store instance
 * @param {string} login Login for ioBroker.net
 * @param {string} password Decoded password for ioBroker.net
 * @returns {Promise<object[]>} array of all licenses stored on iobroker.net
 */
async function updateLicenses(objects, login, password) {
    // if login and password provided in the message, just try to read without saving it in system.licenses
    if (login && password) {
        return _readLicenses(login, password);
    } else {
        // get actual object
        const systemLicenses = await objects.getObjectAsync('system.licenses');
        // If password and login exist
        if (systemLicenses && systemLicenses.native && systemLicenses.native.password && systemLicenses.native.login) {
            try {
                // get the secret to decode the password
                const systemConfig = objects.getObjectAsync('system.config');

                // decode the password
                let password;
                try {
                    password = decrypt(systemConfig.native.secret, systemLicenses.native.password);
                } catch (err) {
                    throw new Error('Cannot decode password: ' + err.message);
                }

                // read licenses from iobroker.net
                const licenses = await _readLicenses(systemLicenses.native.login, password);
                // save licenses to system.licenses and remember the time
                // merge the information together
                const oldLicenses = systemLicenses.native.licenses || [];
                systemLicenses.native.licenses = licenses;
                oldLicenses.forEach(oldLicense => {
                    if (oldLicense.usedBy) {
                        const newLicense = licenses.find(item => item.json === oldLicense.json);
                        if (newLicense) {
                            newLicense.usedBy = oldLicense.usedBy;
                        }
                    }
                });

                systemLicenses.native.readTime = new Date().toISOString();

                // update read time
                await objects.setObjectAsync('system.licenses', systemLicenses);
                return licenses;
            } catch (err) {
                // if password is invalid
                if (
                    err.message.includes('Authentication required') ||
                    err.message.includes('Cannot decode password:')
                ) {
                    // clear existing licenses if exist
                    if (
                        systemLicenses &&
                        systemLicenses.native &&
                        systemLicenses.native.licenses &&
                        systemLicenses.native.licenses.length
                    ) {
                        systemLicenses.native.licenses = [];
                        systemLicenses.native.readTime = new Date().toISOString();
                        await objects.setObjectAsync('system.licenses', systemLicenses);
                    }
                }

                throw err;
            }
        } else {
            // if password or login are empty => clear existing licenses if exist
            if (
                systemLicenses &&
                systemLicenses.native &&
                systemLicenses.native.licenses &&
                systemLicenses.native.licenses.length
            ) {
                systemLicenses.native.licenses = [];
                systemLicenses.native.readTime = new Date().toISOString();
                await objects.setObjectAsync('system.licenses', systemLicenses);
            }
            throw new Error('No password or login');
        }
    }
}

/**
 * @typedef {object} GZipFileOptions
 * @property {boolean} [deleteInput] Delete the input file after compression. Default: false.
 */

/**
 * Compresses an input file using GZip and writes it somewhere else
 * @param {string} inputFilename The filename of the input file that should be gzipped
 * @param {string} outputFilename The filename of the output file where the gzipped content should be written to
 * @param {GZipFileOptions} [options] Options for the compression
 * @returns {Promise<void>}
 */
function compressFileGZip(inputFilename, outputFilename, options = {}) {
    const { deleteInput = false } = options;

    return new Promise((resolve, reject) => {
        const input = fs.createReadStream(inputFilename);
        const output = fs.createWriteStream(outputFilename);
        const compress = zlib.createGzip();
        input.on('error', err => {
            reject(err);
        });
        output.on('error', err => {
            reject(err);
        });
        compress.on('error', err => {
            reject(err);
        });
        output.on('close', () => {
            if (deleteInput) {
                try {
                    fs.unlinkSync(inputFilename);
                } catch {
                    // Ignore
                }
            }
            resolve();
        });

        input.pipe(compress).pipe(output);
    });
}

const ERROR_NOT_FOUND = 'Not exists';
const ERROR_EMPTY_OBJECT = 'null object';
const ERROR_NO_OBJECT = 'no object';
const ERROR_DB_CLOSED = 'DB closed';

module.exports = {
    appName: getAppName(),
    createUuid,
    decryptPhrase,
    execAsync,
    findIPs,
    generateDefaultCertificates,
    getAdapterDir,
    getInstances,
    getAllInstances,
    getCertificateInfo,
    getConfigFileName,
    getDefaultDataDir,
    getDefaultNodeArgs,
    getFile,
    getHostInfo,
    getHostName,
    getInstalledInfo,
    getInstanceIndicatorObjects,
    getIoPack,
    getJson,
    getJsonAsync,
    getInstancesOrderedByStartPrio,
    getRepositoryFile,
    getRepositoryFileAsync,
    getSystemNpmVersion,
    installNodeModule,
    uninstallNodeModule,
    rebuildNodeModules,
    isObject,
    isArray,
    maybeCallback,
    maybeCallbackWithError,
    promisify,
    promisifyNoError,
    promiseSequence,
    removeIdFromAllEnums,
    resolveAdapterMainFile,
    rmdirRecursiveSync,
    parseDependencies,
    sendDiagInfo,
    upToDate,
    validateGeneralObjectProperties,
    checkNonEditable,
    copyAttributes,
    getDiskInfo,
    setQualityForInstance,
    appendStackTrace,
    captureStackTrace,
    pattern2RegEx,
    encrypt,
    decrypt,
    measureEventLoopLag,
    formatAliasValue,
    pipeLinewise,
    isShortGithubUrl,
    parseShortGithubUrl,
    setExecutableCapabilities,
    isGithubPathname,
    isSingleHost,
    isHostRunning,
    parseGithubPathname,
    removePreservedProperties,
    FORBIDDEN_CHARS,
    getControllerDir,
    getLogger,
    getAllEnums,
    updateLicenses,
    compressFileGZip,
    ERRORS: {
        ERROR_NOT_FOUND: ERROR_NOT_FOUND,
        ERROR_EMPTY_OBJECT: ERROR_EMPTY_OBJECT,
        ERROR_NO_OBJECT: ERROR_NO_OBJECT,
        ERROR_DB_CLOSED: ERROR_DB_CLOSED
    }
};
