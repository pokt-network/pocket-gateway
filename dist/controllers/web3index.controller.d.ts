import { Pool as PGPool } from 'pg';
export declare class Web3IndexController {
    private pgPool;
    price: number;
    constructor(pgPool: PGPool);
    generateReport(): Promise<object>;
    totalRevenue(daysBack?: number): Promise<string>;
}
