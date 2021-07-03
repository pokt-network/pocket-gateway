"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Web3IndexController = void 0;
const tslib_1 = require("tslib");
const context_1 = require("@loopback/context");
const rest_1 = require("@loopback/rest");
const pg_1 = require("pg");
let Web3IndexController = class Web3IndexController {
    constructor(pgPool) {
        this.pgPool = pgPool;
        this.price = 0.85;
    }
    async generateReport() {
        let totalRevenue;
        const resultsObject = {
            "revenue": {
                "now": await this.totalRevenue(),
                "oneDayAgo": await this.totalRevenue(1),
                "twoDaysAgo": await this.totalRevenue(2),
                "oneWeekAgo": await this.totalRevenue(7),
                "twoWeeksAgo": await this.totalRevenue(14),
            },
        };
        return resultsObject;
    }
    async totalRevenue(daysBack = 0) {
        let daysBackQuery = '';
        if (daysBack > 0) {
            daysBackQuery = " AND bucket < current_date - interval '" + daysBack + "' day";
        }
        const totalRevenueQuery = "SELECT SUM(total_relays) FROM relay_nodes_hourly WHERE result = '200' AND blockchain = '0021' AND POSITION('fallback' in service_node) = 0" + daysBackQuery;
        console.log(totalRevenueQuery);
        const client = await this.pgPool.connect();
        const results = await client.query(totalRevenueQuery);
        client.release();
        return ((results.rows[0].sum / 100) * this.price).toFixed(2);
    }
};
tslib_1.__decorate([
    rest_1.get('/web3index', {
        responses: {
            '200': {
                description: 'Revenue Data for web3index',
                content: {
                    'application/json': {
                        schema: {
                            type: 'array',
                            items: String,
                        },
                    },
                },
            },
        },
    }),
    tslib_1.__metadata("design:type", Function),
    tslib_1.__metadata("design:paramtypes", []),
    tslib_1.__metadata("design:returntype", Promise)
], Web3IndexController.prototype, "generateReport", null);
Web3IndexController = tslib_1.__decorate([
    tslib_1.__param(0, context_1.inject('pgPool')),
    tslib_1.__metadata("design:paramtypes", [pg_1.Pool])
], Web3IndexController);
exports.Web3IndexController = Web3IndexController;
//# sourceMappingURL=web3index.controller.js.map