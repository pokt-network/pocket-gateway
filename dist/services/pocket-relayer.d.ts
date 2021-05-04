import { CherryPicker } from '../services/cherry-picker';
import { MetricsRecorder } from '../services/metrics-recorder';
import { SyncChecker } from '../services/sync-checker';
import { RelayResponse, Pocket, Configuration, HTTPMethod } from '@pokt-network/pocket-js';
import { Redis } from 'ioredis';
import { BlockchainsRepository } from '../repositories';
import { Applications } from '../models';
export declare class PocketRelayer {
    host: string;
    origin: string;
    userAgent: string;
    pocket: Pocket;
    pocketConfiguration: Configuration;
    cherryPicker: CherryPicker;
    metricsRecorder: MetricsRecorder;
    syncChecker: SyncChecker;
    redis: Redis;
    databaseEncryptionKey: string;
    secretKey: string;
    relayRetries: number;
    blockchainsRepository: BlockchainsRepository;
    checkDebug: boolean;
    fallbacks: Array<URL>;
    constructor({ host, origin, userAgent, pocket, pocketConfiguration, cherryPicker, metricsRecorder, syncChecker, redis, databaseEncryptionKey, secretKey, relayRetries, blockchainsRepository, checkDebug, fallbackURL, }: {
        host: string;
        origin: string;
        userAgent: string;
        pocket: Pocket;
        pocketConfiguration: Configuration;
        cherryPicker: CherryPicker;
        metricsRecorder: MetricsRecorder;
        syncChecker: SyncChecker;
        redis: Redis;
        databaseEncryptionKey: string;
        secretKey: string;
        relayRetries: number;
        blockchainsRepository: BlockchainsRepository;
        checkDebug: boolean;
        fallbackURL: string;
    });
    sendRelay(rawData: object, relayPath: string, httpMethod: HTTPMethod, application: Applications, requestID: string, requestTimeOut?: number, overallTimeOut?: number, relayRetries?: number): Promise<string | Error>;
    _sendRelay(data: string, relayPath: string, httpMethod: HTTPMethod, requestID: string, application: Applications, requestTimeOut: number | undefined, blockchain: string, blockchainEnforceResult: string, blockchainSyncCheck: string): Promise<RelayResponse | Error>;
    fetchClientTypeLog(blockchain: string, id: string | undefined): Promise<string | null>;
    parseMethod(parsedRawData: any): string;
    updateConfiguration(requestTimeOut: number): Configuration;
    loadBlockchain(): Promise<string[]>;
    checkEnforcementJSON(test: string): boolean;
    checkSecretKey(application: Applications): boolean;
    checkWhitelist(tests: string[], check: string, type: string): boolean;
}
