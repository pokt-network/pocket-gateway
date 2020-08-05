"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const context_1 = require("@loopback/context");
const repository_1 = require("@loopback/repository");
const rest_1 = require("@loopback/rest");
const models_1 = require("../models");
const repositories_1 = require("../repositories");
const pocket_js_1 = require("@pokt-network/pocket-js");
const pg_1 = require("pg");
const pgFormat = require("pg-format");
let V1Controller = class V1Controller {
    constructor(secretKey, host, origin, userAgent, contentType, relayPath, pocket, pocketConfiguration, redis, pgPool, processUID, applicationsRepository, blockchainsRepository) {
        this.secretKey = secretKey;
        this.host = host;
        this.origin = origin;
        this.userAgent = userAgent;
        this.contentType = contentType;
        this.relayPath = relayPath;
        this.pocket = pocket;
        this.pocketConfiguration = pocketConfiguration;
        this.redis = redis;
        this.pgPool = pgPool;
        this.processUID = processUID;
        this.applicationsRepository = applicationsRepository;
        this.blockchainsRepository = blockchainsRepository;
    }
    async attemptRelay(id, rawData, filter) {
        // Temporarily only taking in JSON objects
        const data = JSON.stringify(rawData);
        console.log("PROCESSING " + id + " host: " + this.host + " req: " + data);
        const elapsedStart = process.hrtime();
        // Load the requested blockchain
        const cachedBlockchains = await this.redis.get("blockchains");
        let blockchains, blockchain;
        if (!cachedBlockchains) {
            blockchains = await this.blockchainsRepository.find();
            await this.redis.set("blockchains", JSON.stringify(blockchains), "EX", 1);
        }
        else {
            blockchains = JSON.parse(cachedBlockchains);
        }
        // Split off the first part of the request's host and check for matches
        const blockchainRequest = this.host.split(".")[0];
        const blockchainFilter = blockchains.filter((b) => b.blockchain.toLowerCase() === blockchainRequest.toLowerCase());
        if (blockchainFilter[0]) {
            blockchain = blockchainFilter[0].hash;
        }
        else {
            throw new rest_1.HttpErrors.BadRequest("Incorrect blockchain: " + this.host);
        }
        // Construct Pocket AAT from cache; if not available, use the db
        const cachedApp = await this.redis.get(id);
        let app;
        if (!cachedApp) {
            app = await this.applicationsRepository.findById(id, filter);
            await this.redis.set(id, JSON.stringify(app), "EX", 60);
        }
        else {
            app = JSON.parse(cachedApp);
        }
        // Check secretKey; is it required? does it pass?
        if (app.gatewaySettings.secretKeyRequired && this.secretKey !== app.gatewaySettings.secretKey) {
            throw new rest_1.HttpErrors.Forbidden("SecretKey does not match");
        }
        // Whitelist: origins -- explicit matches
        if (!this.checkWhitelist(app.gatewaySettings.whitelistOrigins, this.origin, "explicit")) {
            throw new rest_1.HttpErrors.Forbidden("Whitelist Origin check failed: " + this.origin);
        }
        // Whitelist: userAgent -- substring matches
        if (!this.checkWhitelist(app.gatewaySettings.whitelistUserAgents, this.userAgent, "substring")) {
            throw new rest_1.HttpErrors.Forbidden("Whitelist User Agent check failed: " + this.userAgent);
        }
        // Checks pass; create AAT
        const pocketAAT = new pocket_js_1.PocketAAT(app.aat.version, app.aat.clientPublicKey, app.aat.applicationPublicKey, app.aat.applicationSignature);
        let node;
        // Pull a random node for this relay
        // TODO: weighted pulls; status/ time to relay
        const pocketSession = await this.pocket.sessionManager.getCurrentSession(pocketAAT, blockchain, this.pocketConfiguration);
        if (pocketSession instanceof pocket_js_1.Session) {
            node = await this.cherryPickNode(pocketSession, blockchain);
        }
        // Send relay and process return: RelayResponse, RpcError, ConsensusNode, or undefined
        const relayResponse = await this.pocket.sendRelay(data, blockchain, pocketAAT, this.pocketConfiguration, undefined, undefined, this.relayPath, node);
        if (this.checkDebug()) {
            console.log(relayResponse);
        }
        // Success
        if (relayResponse instanceof pocket_js_1.RelayResponse) {
            console.log("SUCCESS " + id + " chain: " + blockchain + " req: " + JSON.stringify(data) + " res: " + relayResponse.payload);
            const bytes = Buffer.byteLength(relayResponse.payload, 'utf8');
            await this.recordMetric({
                appPubKey: app.appPubKey,
                blockchain,
                serviceNode: relayResponse.proof.servicerPubKey,
                elapsedStart,
                result: 200,
                bytes,
            });
            return relayResponse.payload;
        }
        // Error
        else if (relayResponse instanceof pocket_js_1.RpcError) {
            console.log("ERROR " + id + " chain: " + blockchain + " req: " + JSON.stringify(data) + " res: " + relayResponse.message);
            const bytes = Buffer.byteLength(relayResponse.message, 'utf8');
            await this.recordMetric({
                appPubKey: app.appPubKey,
                blockchain,
                serviceNode: node === null || node === void 0 ? void 0 : node.publicKey,
                elapsedStart,
                result: 500,
                bytes,
            });
            throw new rest_1.HttpErrors.InternalServerError(relayResponse.message);
        }
        // ConsensusNode
        else {
            // TODO: ConsensusNode is a possible return
            throw new rest_1.HttpErrors.InternalServerError("relayResponse is undefined");
        }
    }
    // Check passed in string against an array of whitelisted items
    // Type can be "explicit" or substring match
    checkWhitelist(tests, check, type) {
        if (!tests || tests.length === 0) {
            return true;
        }
        if (!check) {
            return false;
        }
        for (const test of tests) {
            if (type === "explicit") {
                if (test.toLowerCase() === check.toLowerCase()) {
                    return true;
                }
            }
            else {
                if (check.toLowerCase().includes(test.toLowerCase())) {
                    return true;
                }
            }
        }
        return false;
    }
    // Debug log for testing based on user agent
    checkDebug() {
        if (this.userAgent &&
            this.userAgent.toLowerCase().includes('pocket-debug')) {
            return true;
        }
        return false;
    }
    // Record relay metrics in redis then push to timescaleDB for analytics
    async recordMetric({ appPubKey, blockchain, serviceNode, elapsedStart, result, bytes, }) {
        try {
            const elapsedEnd = process.hrtime(elapsedStart);
            const elapsedTime = (elapsedEnd[0] * 1e9 + elapsedEnd[1]) / 1e9;
            const metricsValues = [
                new Date(),
                appPubKey,
                blockchain,
                serviceNode,
                elapsedTime,
                result,
                bytes,
            ];
            // Store metrics in redis and every 10 seconds, push to postgres
            const redisMetricsKey = "metrics-" + this.processUID;
            const redisListAge = await this.redis.get("age-" + redisMetricsKey);
            const redisListSize = await this.redis.llen(redisMetricsKey);
            const currentTimestamp = Math.floor(new Date().getTime() / 1000);
            // List has been started in redis and needs to be pushed as timestamp is > 10 seconds old
            if (redisListAge &&
                redisListSize > 0 &&
                currentTimestamp > parseInt(redisListAge) + 10) {
                await this.redis.set("age-" + redisMetricsKey, currentTimestamp);
                const bulkData = [metricsValues];
                for (let count = 0; count < redisListSize; count++) {
                    const redisRecord = await this.redis.lpop(redisMetricsKey);
                    bulkData.push(JSON.parse(redisRecord));
                }
                const metricsQuery = pgFormat("INSERT INTO relay VALUES %L", bulkData);
                this.pgPool.query(metricsQuery);
            }
            else {
                await this.redis.rpush(redisMetricsKey, JSON.stringify(metricsValues));
            }
            if (!redisListAge) {
                await this.redis.set("age-" + redisMetricsKey, currentTimestamp);
            }
            if (serviceNode) {
                await this.updateServiceNodeQuality(blockchain, serviceNode, elapsedTime, result);
            }
        }
        catch (err) {
            console.log(err.stack);
        }
    }
    // Record node service quality in redis for future node selection weight
    // { serviceNode: { results: { 200: x, 500: y, ... }, averageSuccessLatency: z }
    async updateServiceNodeQuality(blockchain, serviceNode, elapsedTime, result) {
        const serviceLog = await this.fetchServiceLog(blockchain, serviceNode);
        let serviceNodeQuality;
        // Update service quality log for this hour
        if (serviceLog) {
            serviceNodeQuality = JSON.parse(serviceLog);
            let totalResults = 0;
            for (const logResult of Object.keys(serviceNodeQuality.results)) {
                // Add the current result into the total results
                if (parseInt(logResult) === result) {
                    serviceNodeQuality.results[logResult]++;
                }
                totalResults = totalResults + serviceNodeQuality.results[logResult];
            }
            // Success; add this result's latency to the average latency of all success requests
            if (result === 200) {
                serviceNodeQuality.averageSuccessLatency = ((((totalResults - 1) * serviceNodeQuality.averageSuccessLatency) + elapsedTime) // All previous results plus current
                    / totalResults // divided by total results
                ).toFixed(5); // to 5 decimal points
            }
        }
        else {
            // No current logs found for this hour
            const results = { [result]: 1 };
            if (result !== 200) {
                elapsedTime = 0;
            }
            serviceNodeQuality = {
                results: results,
                averageSuccessLatency: elapsedTime.toFixed(5)
            };
        }
        await this.redis.set(blockchain + "-" + serviceNode + "-" + new Date().getHours(), JSON.stringify(serviceNodeQuality), "EX", 3600);
        console.log(serviceNodeQuality);
    }
    // Fetch node's hourly service log from redis
    async fetchServiceLog(blockchain, serviceNode) {
        const serviceLog = await this.redis.get(blockchain + "-" + serviceNode + "-" + new Date().getHours());
        return serviceLog;
    }
    // Per hour, record the latency and success rate of each node
    // When selecting a node, pull the stats for each node in the session
    // Rank and weight them for node choice
    async cherryPickNode(pocketSession, blockchain) {
        const rawNodes = {};
        const sortedLogs = [];
        for (const node of pocketSession.sessionNodes) {
            rawNodes[node.publicKey] = node;
            const serviceLog = await this.fetchServiceLog(blockchain, node.publicKey);
            if (this.checkDebug()) {
                console.log(serviceLog);
            }
            let attempts = 0;
            let successRate = 0;
            let averageSuccessLatency = 0;
            if (!serviceLog) {
                // Node hasn't had a relay in the past hour
                // Success rate of 1 boosts this node into the primary group so it gets tested
                successRate = 1;
                averageSuccessLatency = 0;
            }
            else {
                const parsedLog = JSON.parse(serviceLog);
                // Count total relay atttempts with any result
                for (const result of Object.keys(parsedLog.results)) {
                    attempts = attempts + parsedLog.results[result];
                }
                // Has the node had any success in the past hour?
                if (parsedLog.results["200"] > 0) {
                    successRate = (parsedLog.results["200"] / attempts);
                    averageSuccessLatency = parseFloat(parseFloat(parsedLog.averageSuccessLatency).toFixed(5));
                }
            }
            sortedLogs.push({
                nodePublicKey: node.publicKey,
                attempts: attempts,
                successRate: successRate,
                averageSuccessLatency: averageSuccessLatency,
            });
        }
        ;
        // Sort node logs by highest success rate, then by lowest latency
        sortedLogs.sort((a, b) => {
            if (a.successRate < b.successRate) {
                return 1;
            }
            else if (a.successRate > b.successRate) {
                return -1;
            }
            if (a.successRate === b.successRate) {
                if (a.averageSuccessLatency > b.averageSuccessLatency) {
                    return 1;
                }
                else if (a.averageSuccessLatency < b.averageSuccessLatency) {
                    return -1;
                }
                return 0;
            }
            return 0;
        });
        if (this.checkDebug()) {
            console.log(sortedLogs);
        }
        // Iterate through sorted logs and form in to a weighted list of nodes
        let rankedNodes = [];
        // weightFactor pushes the fastest nodes with the highest success rates 
        // to be called on more often for relays.
        // 
        // The node with the highest success rate and the lowest average latency will
        // be 10 times more likely to be selected than a node that has had failures.
        let weightFactor = 10;
        // The number of failures tolerated per hour before being removed from rotation
        const maxFailuresPerHour = 10;
        for (const sortedLog of sortedLogs) {
            if (sortedLog.successRate === 1) {
                // For untested nodes and nodes with 100% success rates, weight their selection
                for (let x = 1; x <= weightFactor; x++) {
                    rankedNodes.push(rawNodes[sortedLog.nodePublicKey]);
                }
                weightFactor = weightFactor - 2;
            }
            else if (sortedLog.successRate > 0.95) {
                // For all nodes with reasonable success rate, weight their selection less
                for (let x = 1; x <= weightFactor; x++) {
                    rankedNodes.push(rawNodes[sortedLog.nodePublicKey]);
                }
                weightFactor = weightFactor - 3;
                if (weightFactor <= 0) {
                    weightFactor = 1;
                }
            }
            else if (sortedLog.successRate > 0) {
                // For all nodes with limited success rate, do not weight
                rankedNodes.push(rawNodes[sortedLog.nodePublicKey]);
            }
            else if (sortedLog.successRate === 0) {
                // If a node has a 0% success rate and < max failures, keep them in rotation
                // If a node has a 0% success rate and > max failures shelve them until next hour
                if (sortedLog.attempts < maxFailuresPerHour) {
                    rankedNodes.push(rawNodes[sortedLog.nodePublicKey]);
                }
            }
        }
        // If we have no nodes left because all 5 are failures, ¯\_(ツ)_/¯
        if (rankedNodes.length === 0) {
            rankedNodes = pocketSession.sessionNodes;
        }
        const selectedNode = Math.floor(Math.random() * (rankedNodes.length));
        const node = rankedNodes[selectedNode];
        if (this.checkDebug()) {
            console.log("Number of weighted nodes for selection: " + rankedNodes.length);
            console.log("Selected " + selectedNode + " : " + node.publicKey);
        }
        return node;
    }
};
tslib_1.__decorate([
    rest_1.post("/v1/{id}", {
        responses: {
            "200": {
                description: "Relay Response",
                content: {
                    "application/json": {},
                },
            },
        },
    }),
    tslib_1.__param(0, rest_1.param.path.string("id")),
    tslib_1.__param(1, rest_1.requestBody({
        description: 'request object value',
        required: true,
        content: {
            'application/json': {}
        }
    })),
    tslib_1.__param(2, rest_1.param.filter(models_1.Applications, { exclude: "where" })),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", [String, Object, Object]),
    tslib_1.__metadata("design:returntype", Promise)
], V1Controller.prototype, "attemptRelay", null);
V1Controller = tslib_1.__decorate([
    tslib_1.__param(0, context_1.inject("secretKey")),
    tslib_1.__param(1, context_1.inject("host")),
    tslib_1.__param(2, context_1.inject("origin")),
    tslib_1.__param(3, context_1.inject("userAgent")),
    tslib_1.__param(4, context_1.inject("contentType")),
    tslib_1.__param(5, context_1.inject("relayPath")),
    tslib_1.__param(6, context_1.inject("pocketInstance")),
    tslib_1.__param(7, context_1.inject("pocketConfiguration")),
    tslib_1.__param(8, context_1.inject("redisInstance")),
    tslib_1.__param(9, context_1.inject("pgPool")),
    tslib_1.__param(10, context_1.inject("processUID")),
    tslib_1.__param(11, repository_1.repository(repositories_1.ApplicationsRepository)),
    tslib_1.__param(12, repository_1.repository(repositories_1.BlockchainsRepository)),
    tslib_1.__metadata("design:paramtypes", [String, String, String, String, String, String, pocket_js_1.Pocket,
        pocket_js_1.Configuration, Object, pg_1.Pool, String, repositories_1.ApplicationsRepository,
        repositories_1.BlockchainsRepository])
], V1Controller);
exports.V1Controller = V1Controller;
//# sourceMappingURL=v1.controller.js.map