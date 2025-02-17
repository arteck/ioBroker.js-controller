/**
 *      States DB in memory - Server with Redis protocol
 *
 *      Copyright 2013-2021 bluefox <dogafox@gmail.com>
 *
 *      MIT License
 *
 */

/** @module statesInMemory */

/* jshint -W097 */
/* jshint strict:false */
/* jslint node: true */
'use strict';

const ObjectsInRedisClient = require('@iobroker/db-objects-redis').Client;
const ObjectsInMemServer = require('./objectsInMemServerRedis');

class ObjectsInMemoryServerClass extends ObjectsInRedisClient {
    constructor(settings) {
        settings.autoConnect = false; // delay Client connection to when we need it
        super(settings);

        const serverSettings = {
            namespace: settings.namespace ? `${settings.namespace}-Server` : 'Server',
            connection: settings.connection,
            logger: settings.logger,
            hostname: settings.hostname,
            connected: () => {
                this.connectDb(); // now that server is connected also connect client
            }
        };
        this.objectsServer = new ObjectsInMemServer(serverSettings);
    }

    async destroy() {
        await super.destroy(); // destroy client first
        await this.objectsServer.destroy(); // server afterwards too
    }

    getStatus() {
        return this.objectsServer.getStatus(); // return Status as Server
    }

    syncFileDirectory(limitId) {
        return this.objectsServer.syncFileDirectory(limitId);
    }

    dirExists(id, name) {
        return this.objectsServer.dirExists(id, name);
    }
}
module.exports = ObjectsInMemoryServerClass;
