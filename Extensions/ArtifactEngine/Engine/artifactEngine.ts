﻿import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline'
var crypto = require('crypto');

var tl = require('vsts-task-lib/task');

import * as models from '../Models';
import * as ci from './cilogger';
import { ArtifactItemStore } from '../Store/artifactItemStore';
import { ArtifactEngineOptions } from "./artifactEngineOptions"
import { Logger } from './logger';
import { Worker } from './worker';
import { TicketState } from '../Models/ticketState';
import { CacheProvider } from '../Providers/cacheProvider';

export class ArtifactEngine {
    processItems(sourceProvider: models.IArtifactProvider, destProvider: models.IArtifactProvider, artifactEngineOptions?: ArtifactEngineOptions): Promise<models.ArtifactDownloadTicket[]> {
        var artifactDownloadTicketsPromise = new Promise<models.ArtifactDownloadTicket[]>((resolve, reject) => {
            const workers: Promise<void>[] = [];
            artifactEngineOptions = artifactEngineOptions || new ArtifactEngineOptions();            
            this.createPatternList(artifactEngineOptions);
            var artifactName = sourceProvider.getRootItemPath();
            this.artifactItemStore = new ArtifactItemStore(artifactName);
            this.artifactItemStore.flush();
            Logger.verbose = artifactEngineOptions.verbose;
            this.logger = new Logger(this.artifactItemStore, artifactEngineOptions);
            this.logger.logProgress();
            sourceProvider.artifactItemStore = this.artifactItemStore;
            destProvider.artifactItemStore = this.artifactItemStore;
            this.cacheProvider = new CacheProvider(artifactEngineOptions.artifactCacheDirectory, artifactEngineOptions.artifactCacheHashKey, artifactName);
            sourceProvider.getRootItems().then((itemsToProcess: models.ArtifactItem[]) => {
                this.artifactItemStore.addItems(itemsToProcess);
                this.createNewHashMap(sourceProvider, itemsToProcess, artifactEngineOptions).then(() => {
                    for (let i = 0; i < artifactEngineOptions.parallelProcessingLimit; ++i) {
                        var worker = new Worker<models.ArtifactItem>(i + 1, item => this.processArtifactItem(sourceProvider, item, destProvider, artifactEngineOptions), () => this.artifactItemStore.getNextItemToProcess(), () => !this.artifactItemStore.itemsPendingProcessing());
                        workers.push(worker.init());
                    }

                    Promise.all(workers).then(() => {
                        this.logger.logSummary();
                        if (artifactEngineOptions.enableIncrementalDownload) {
                            if (this.artifactItemStore._downloadTickets.find(x => x.state === models.TicketState.Failed)) {
                                sourceProvider.dispose();
                                destProvider.dispose();
                                resolve(this.artifactItemStore.getTickets());
                            }
                            else {
                                this.updateCache(sourceProvider, destProvider).then(() => {
                                    resolve(this.artifactItemStore.getTickets());
                                });
                            }
                        }
                        else {
                            sourceProvider.dispose();
                            destProvider.dispose();
                            resolve(this.artifactItemStore.getTickets());
                        }
                    }, (err) => {
                        ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                        sourceProvider.dispose();
                        destProvider.dispose();
                        reject(err);
                    });
                });
            }, (err) => {
                ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                sourceProvider.dispose();
                destProvider.dispose();
                reject(err);
            });
        });

        return artifactDownloadTicketsPromise;
    }

    processArtifactItem(sourceProvider: models.IArtifactProvider,
        item: models.ArtifactItem,
        destProvider: models.IArtifactProvider,
        artifactEngineOptions: ArtifactEngineOptions): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.processArtifactItemImplementation(sourceProvider, item, destProvider, artifactEngineOptions, resolve, reject);
        });
    }

    processArtifactItemImplementation(sourceProvider: models.IArtifactProvider,
        item: models.ArtifactItem,
        destProvider: models.IArtifactProvider,
        artifactEngineOptions: ArtifactEngineOptions,
        resolve,
        reject,
        retryCount?: number) {
        var retryIfRequired = (err) => {
            if (retryCount === artifactEngineOptions.retryLimit - 1) {
                this.artifactItemStore.updateState(item, models.TicketState.Failed);
                reject(err);
            } else {
                this.artifactItemStore.increaseRetryCount(item);
                Logger.logMessage(tl.loc("RetryingDownload", item.path, (retryCount + 1)));
                setTimeout(() => this
                    .processArtifactItemImplementation(sourceProvider, item, destProvider, artifactEngineOptions, resolve, reject, retryCount + 1), artifactEngineOptions.retryIntervalInSeconds * 1000);
            }
        }
        retryCount = retryCount ? retryCount : 0;
        if (item.itemType === models.ItemType.File) {
            var pathToMatch = item.path.replace(/\\/g, '/');
            var matchOptions = {
                debug: false,
                nobrace: true,
                noglobstar: false,
                dot: true,
                noext: false,
                nocase: false,
                nonull: false,
                matchBase: false,
                nocomment: false,
                nonegate: false,
                flipNegate: false
            };

            if (tl.match([pathToMatch], this.patternList, null, matchOptions).length > 0) {
                Logger.logInfo("Processing " + item.path);
                var downloadedFromCache = false;
                var getContentStream = new Promise<NodeJS.ReadableStream>((resolve, reject) => {
                    this.cacheProvider.getArtifactItem(item).then((contentStream) => {
                        if (!contentStream) {
                            Logger.logMessage(tl.loc("SourceDownload", item.path));
                            sourceProvider.getArtifactItem(item).then((contentStream) => {
                                Logger.logInfo("Got download stream for item: " + item.path);
                                resolve(contentStream);
                            });
                        }
                        else {
                            Logger.logMessage(tl.loc("CacheDownload", item.path));
                            downloadedFromCache = true;
                            resolve(contentStream);
                        }
                    }, (err) => {
                        ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                        reject(err);
                    });
                });

                getContentStream.then((contentStream) => {
                    destProvider.putArtifactItem(item, contentStream).then((item) => {
                        var isDownloadedItemContentValid = this.artifactItemStore.updateState(item, models.TicketState.Processed, downloadedFromCache)
                        if (!isDownloadedItemContentValid) {
                            tl.rmRF(path.join(destProvider.getRootLocation(), item.path));
                            var error = new Error(`Hash Validation of ${item.path} failed while downloading.`);
                            Logger.logInfo("Hash Validation Failed. Retrying Download of " + item.path);
                            retryIfRequired(error);
                        }
                        else {
                            resolve();
                        }
                    }, (err) => {
                        Logger.logInfo("Error placing file " + item.path + ": " + err);
                        retryIfRequired(err);
                    });
                }, (err) => {
                    Logger.logInfo("Error getting file " + item.path + ": " + err);
                    retryIfRequired(err);
                });
            }
            else {
                Logger.logMessage(tl.loc("SkippingItem", pathToMatch));
                this.artifactItemStore.updateState(item, models.TicketState.Skipped);
                resolve();
            }
        }
        else {
            sourceProvider.getArtifactItems(item).then((items: models.ArtifactItem[]) => {
                items = items.map((value, index) => {
                    if (!value.path.toLowerCase().startsWith(item.path.toLowerCase())) {
                        value.path = path.join(item.path, value.path);
                    }

                    return value;
                });

                this.artifactItemStore.addItems(items);
                this.artifactItemStore.updateState(item, models.TicketState.Processed);

                Logger.logInfo("Enqueued " + items.length + " for processing.");
                resolve();
            }, (err) => {
                Logger.logInfo("Error getting " + item.path + ":" + err);
                retryIfRequired(err);
            });
        }
    }

    createPatternList(artifactEngineOptions: ArtifactEngineOptions) {
        if (!artifactEngineOptions.itemPattern) {
            this.patternList = ['**'];
        }
        else {
            this.patternList = artifactEngineOptions.itemPattern.split('\n');
            if (artifactEngineOptions.enableIncrementalDownload) {
                this.patternList.push(`**\\${models.Constants.MetadataFile}`);
            }
        }
    }

    createNewHashMap(sourceProvider: models.IArtifactProvider, itemsToProcess: models.ArtifactItem[], artifactEngineOptions?: ArtifactEngineOptions): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!artifactEngineOptions.enableIncrementalDownload) {
                this.filePathToFileHashMap = {};
                resolve();
            }
            else {
                sourceProvider.getArtifactItems(itemsToProcess[0]).then((items: models.ArtifactItem[]) => {
                    sourceProvider.getArtifactItem(items.find(x => path.normalize(x.path) === path.join(itemsToProcess[0].path, models.Constants.MetadataFile))).then((hashStream: NodeJS.ReadableStream) => {
                        var newHashPromise = new Promise((resolve) => {
                            var isMetadataCorrupt = false;
                            var newHash = readline.createInterface({
                                input: hashStream
                            });

                            newHash.on('line', (line) => {
                                var words = line.split(',');
                                if (words.length === 2) {
                                    this.filePathToFileHashMap[words[0]] = words[1];
                                }
                                else {
                                    Logger.logMessage(tl.loc("MetadataCorrupt"))
                                    isMetadataCorrupt = true;
                                }
                            });

                            newHash.on('close', () => {
                                if (isMetadataCorrupt) {
                                    this.filePathToFileHashMap = {};
                                    artifactEngineOptions.enableIncrementalDownload = false;
                                }
                                resolve();
                            });
                        });
                        newHashPromise.then(() => {
                            this.artifactItemStore.setHashMap(this.filePathToFileHashMap)
                            resolve();
                        });
                    }, (err) => {
                        Logger.logInfo("Incremental Download Failed. Downloading normally.");
                        ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                        artifactEngineOptions.enableIncrementalDownload = false;
                        this.filePathToFileHashMap = {};
                        resolve();
                    });
                }, (err) => {
                    Logger.logInfo("Incremental Download Failed. Downloading normally.");
                    ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                    artifactEngineOptions.enableIncrementalDownload = false;
                    this.filePathToFileHashMap = {};
                    resolve();
                });
            }
        });
    }

    updateCache(sourceProvider: models.IArtifactProvider, destProvider: models.IArtifactProvider) {
        return new Promise((resolve,reject) => {
            var destination = destProvider.getRootLocation();
            var artifactName = sourceProvider.getRootItemPath();
            var cachePath = this.cacheProvider.getCacheDirectory();
            if (fs.existsSync(cachePath)) {
                tl.rmRF(cachePath);
            }
            tl.mkdirP(cachePath);
            tl.cp((path.join(destination, artifactName) + '/.'), cachePath, '-r');
            var verifyFile = fs.createWriteStream(path.join(cachePath, "verify.json"));
            verifyFile.write(JSON.stringify({ lastUpdatedOn: new Date().toISOString() }), () => {
                sourceProvider.dispose();
                destProvider.dispose();
                verifyFile.close();
                resolve();
            });
            verifyFile.on('error', (err) => {
                ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'error', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
                Logger.logInfo(err);
                reject(err);
            });
        });        
    }

    private artifactItemStore: ArtifactItemStore;
    private logger: Logger;
    private cacheProvider: CacheProvider;
    private patternList: string[];
    private filePathToFileHashMap = {};
}

tl.setResourcePath(path.join(path.dirname(__dirname), 'lib.json'));
process.on('unhandledRejection', (err) => {
    ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'unhandledRejection', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
    Logger.logError(tl.loc("UnhandledRejection", err));
    throw err;
});

process.on('uncaughtException', (err) => {
    ci.publishEvent('reliability', <ci.IReliabilityData>{ issueType: 'uncaughtException', errorMessage: JSON.stringify(err, Object.getOwnPropertyNames(err)) });
    Logger.logError(tl.loc("UnhandledException", err));
    throw err;
});