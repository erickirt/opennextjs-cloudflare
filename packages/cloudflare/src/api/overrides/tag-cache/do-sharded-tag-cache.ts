import { debug, error } from "@opennextjs/aws/adapters/logger.js";
import { generateShardId } from "@opennextjs/aws/core/routing/queue.js";
import type { NextModeTagCache } from "@opennextjs/aws/types/overrides.js";
import { IgnorableError } from "@opennextjs/aws/utils/error.js";

import type { OpenNextConfig } from "../../../api/config.js";
import { getCloudflareContext } from "../../cloudflare-context";
import { debugCache, purgeCacheByTags } from "../internal";

export const DEFAULT_WRITE_RETRIES = 3;
export const DEFAULT_NUM_SHARDS = 4;
export const NAME = "do-sharded-tag-cache";

const SOFT_TAG_PREFIX = "_N_T_/";
export const DEFAULT_REGION = "enam" as const;
export const AVAILABLE_REGIONS = ["enam", "weur", "apac", "sam", "afr", "oc"] as const;
type AllowedDurableObjectRegion = (typeof AVAILABLE_REGIONS)[number];

interface ShardedDOTagCacheOptions {
	/**
	 * The number of shards that will be used.
	 *
	 * 1 shards means 1 durable object instance.
	 * Soft (internal next tags used for `revalidatePath`) and hard tags (the one you define in your app)
	 * will be split in different shards.
	 *
	 * The number of requests made to Durable Objects will scale linearly with the number of shards.
	 * For example, a request involving 5 tags may access between 1 and 5 shards, with the upper limit being
	 * the lesser of the number of tags or the number of shards
	 *
	 * @default 4
	 */
	baseShardSize: number;

	/**
	 * Whether to enable a regional cache on a per-shard basis
	 * Because of the way tags are implemented in Next.js, some shards will have more requests than others. For these cases, it is recommended to enable the regional cache.
	 *
	 * @default false
	 */
	regionalCache?: boolean;

	/**
	 * The TTL for the regional cache in seconds
	 * Increasing this value will reduce the number of requests to the Durable Object, but it could make `revalidateTags`/`revalidatePath` call being longer to take effect
	 *
	 * @default 5
	 */
	regionalCacheTtlSec?: number;

	/**
	 * Enable shard replication to handle higher load.
	 *
	 * By default shards are not replicated (`numberOfSoftReplicas = 1` or `numberOfHardReplicas = 1`).
	 *
	 * Setting the number of replicas to a number greater than 1 will replicate the shards.
	 * Write operations always apply to all of the shards.
	 * However read operations read from a single shard to spread the load.
	 *
	 * Soft replicas are for internal next tags used for `revalidatePath` (i.e. `_N_T_/layout`, `_N_T_/page1`).
	 * Hard replicas are the tags defined in your app.
	 *
	 * Soft replicas are accessed more often  than hard replicas, so it is recommended to have more soft replicas
	 * than hard replicas (2x is a good rule of thumb)
	 */
	shardReplication?: {
		numberOfSoftReplicas: number;
		numberOfHardReplicas: number;

		/**
		 * Enable regional replication for the shards.
		 *
		 * If not set, no regional replication will be performed and durable objects will be created without a location hint
		 *
		 * Can be used to reduce latency for users in different regions and to spread the load across multiple regions.
		 *
		 * This will increase the number of durable objects created, as each shard will be replicated in all regions.
		 */
		regionalReplication?: {
			defaultRegion: AllowedDurableObjectRegion;
		};
	};

	/**
	 * The number of retries to perform when writing tags
	 *
	 * @default 3
	 */
	maxWriteRetries?: number;
}

interface DOIdOptions {
	baseShardId: string;
	numberOfReplicas: number;
	shardType: "soft" | "hard";
	replicaId?: number;
	region?: DurableObjectLocationHint;
}

export class DOId {
	shardId: string;
	replicaId: number;
	region?: DurableObjectLocationHint;
	constructor(public options: DOIdOptions) {
		const { baseShardId, shardType, numberOfReplicas, replicaId, region } = options;
		this.shardId = `tag-${shardType};${baseShardId}`;
		this.replicaId = replicaId ?? this.generateRandomNumberBetween(1, numberOfReplicas);
		this.region = region;
	}

	private generateRandomNumberBetween(min: number, max: number) {
		return Math.floor(Math.random() * (max - min + 1) + min);
	}

	get key() {
		return `${this.shardId};replica-${this.replicaId}${this.region ? `;region-${this.region}` : ""}`;
	}
}

interface CacheTagKeyOptions {
	doId: DOId;
	tags: string[];
	type: "boolean" | "number";
}
class ShardedDOTagCache implements NextModeTagCache {
	readonly mode = "nextMode" as const;
	readonly name = NAME;
	readonly numSoftReplicas: number;
	readonly numHardReplicas: number;
	readonly maxWriteRetries: number;
	readonly enableRegionalReplication: boolean;
	readonly defaultRegion: AllowedDurableObjectRegion;
	localCache?: Cache;

	constructor(private opts: ShardedDOTagCacheOptions = { baseShardSize: DEFAULT_NUM_SHARDS }) {
		this.numSoftReplicas = opts.shardReplication?.numberOfSoftReplicas ?? 1;
		this.numHardReplicas = opts.shardReplication?.numberOfHardReplicas ?? 1;
		this.maxWriteRetries = opts.maxWriteRetries ?? DEFAULT_WRITE_RETRIES;
		this.enableRegionalReplication = Boolean(opts.shardReplication?.regionalReplication);
		this.defaultRegion = opts.shardReplication?.regionalReplication?.defaultRegion ?? DEFAULT_REGION;
	}

	private getDurableObjectStub(doId: DOId) {
		const durableObject = getCloudflareContext().env.NEXT_TAG_CACHE_DO_SHARDED;
		if (!durableObject) throw new IgnorableError("No durable object binding for cache revalidation");

		const id = durableObject.idFromName(doId.key);
		debug("[shardedTagCache] - Accessing Durable Object : ", {
			key: doId.key,
			region: doId.region,
		});
		return durableObject.get(id, { locationHint: doId.region });
	}

	/**
	 * Generates a list of DO ids for the shards and replicas
	 * @param tags The tags to generate shards for
	 * @param shardType Whether to generate shards for soft or hard tags
	 * @param generateAllShards Whether to generate all shards or only one
	 * @returns An array of TagCacheDOId and tag
	 */
	private generateDOIdArray({
		tags,
		shardType,
		generateAllReplicas = false,
	}: {
		tags: string[];
		shardType: "soft" | "hard";
		generateAllReplicas: boolean;
	}) {
		let replicaIndexes: Array<number | undefined> = [1];
		const isSoft = shardType === "soft";
		let numReplicas = 1;
		if (this.opts.shardReplication) {
			numReplicas = isSoft ? this.numSoftReplicas : this.numHardReplicas;
			replicaIndexes = generateAllReplicas
				? Array.from({ length: numReplicas }, (_, i) => i + 1)
				: [undefined];
		}
		const regionalReplicas = replicaIndexes.flatMap((replicaId) => {
			return tags
				.filter((tag) => (isSoft ? tag.startsWith(SOFT_TAG_PREFIX) : !tag.startsWith(SOFT_TAG_PREFIX)))
				.map((tag) => {
					return {
						doId: new DOId({
							baseShardId: generateShardId(tag, this.opts.baseShardSize, "shard"),
							numberOfReplicas: numReplicas,
							shardType,
							replicaId,
						}),
						tag,
					};
				});
		});
		if (!this.enableRegionalReplication) return regionalReplicas;

		// If we have regional replication enabled, we need to further duplicate the shards in all the regions
		const regionalReplicasInAllRegions = generateAllReplicas
			? regionalReplicas.flatMap(({ doId, tag }) => {
					return AVAILABLE_REGIONS.map((region) => {
						return {
							doId: new DOId({
								baseShardId: doId.options.baseShardId,
								numberOfReplicas: numReplicas,
								shardType,
								replicaId: doId.replicaId,
								region,
							}),
							tag,
						};
					});
				})
			: regionalReplicas.map(({ doId, tag }) => {
					doId.region = this.getClosestRegion();
					return { doId, tag };
				});
		return regionalReplicasInAllRegions;
	}

	getClosestRegion() {
		const continent = getCloudflareContext().cf?.continent;
		if (!continent) return this.defaultRegion;
		debug("[shardedTagCache] - Continent : ", continent);
		switch (continent) {
			case "AF":
				return "afr";
			case "AS":
				return "apac";
			case "EU":
				return "weur";
			case "NA":
				return "enam";
			case "OC":
				return "oc";
			case "SA":
				return "sam";
			default:
				return this.defaultRegion;
		}
	}

	/**
	 * Same tags are guaranteed to be in the same shard
	 * @param tags
	 * @returns An array of DO ids and tags
	 */
	groupTagsByDO({ tags, generateAllReplicas = false }: { tags: string[]; generateAllReplicas?: boolean }) {
		// Here we'll start by splitting soft tags from hard tags
		// This will greatly increase the cache hit rate for the soft tag (which are the most likely to cause issue because of load)
		const softTags = this.generateDOIdArray({ tags, shardType: "soft", generateAllReplicas });

		const hardTags = this.generateDOIdArray({ tags, shardType: "hard", generateAllReplicas });

		const tagIdCollection = [...softTags, ...hardTags];

		// We then group the tags by DO id
		const tagsByDOId = new Map<
			string,
			{
				doId: DOId;
				tags: string[];
			}
		>();
		for (const { doId, tag } of tagIdCollection) {
			const doIdString = doId.key;
			const tagsArray = tagsByDOId.get(doIdString)?.tags ?? [];
			tagsArray.push(tag);
			tagsByDOId.set(doIdString, {
				// We override the doId here, but it should be the same for all tags
				doId,
				tags: tagsArray,
			});
		}
		const result = Array.from(tagsByDOId.values());
		return result;
	}

	private async getConfig() {
		const cfEnv = getCloudflareContext().env;
		const db = cfEnv.NEXT_TAG_CACHE_DO_SHARDED;

		if (!db) debugCache("No Durable object found");
		const isDisabled = !!(globalThis as unknown as { openNextConfig: OpenNextConfig }).openNextConfig
			.dangerous?.disableTagCache;

		return !db || isDisabled
			? { isDisabled: true as const }
			: {
					isDisabled: false as const,
					db,
				};
	}

	async getLastRevalidated(tags: string[]): Promise<number> {
		const { isDisabled } = await this.getConfig();
		if (isDisabled) return 0;
		try {
			const shardedTagGroups = this.groupTagsByDO({ tags });
			const shardedTagRevalidationOutcomes = await Promise.all(
				shardedTagGroups.map(async ({ doId, tags }) => {
					const cachedValue = await this.getFromRegionalCache({ doId, tags, type: "number" });
					if (cachedValue) {
						const cached = await cachedValue.text();
						try {
							return parseInt(cached, 10);
						} catch (e) {
							debug("Error while parsing cached value", e);
							// If we can't parse the cached value, we should just ignore it and go to the durable object
						}
					}
					const stub = this.getDurableObjectStub(doId);
					const _lastRevalidated = await stub.getLastRevalidated(tags);
					if (!_lastRevalidated) {
						getCloudflareContext().ctx.waitUntil(
							this.putToRegionalCache({ doId, tags, type: "number" }, _lastRevalidated)
						);
					}
					return _lastRevalidated;
				})
			);
			return Math.max(...shardedTagRevalidationOutcomes);
		} catch (e) {
			error("Error while checking revalidation", e);
			return 0;
		}
	}

	/**
	 * This function checks if the tags have been revalidated
	 * It is never supposed to throw and in case of error, it will return false
	 * @param tags
	 * @param lastModified default to `Date.now()`
	 * @returns
	 */
	async hasBeenRevalidated(tags: string[], lastModified?: number): Promise<boolean> {
		const { isDisabled } = await this.getConfig();
		if (isDisabled) return false;
		try {
			const shardedTagGroups = this.groupTagsByDO({ tags });
			const shardedTagRevalidationOutcomes = await Promise.all(
				shardedTagGroups.map(async ({ doId, tags }) => {
					const cachedValue = await this.getFromRegionalCache({ doId, tags, type: "boolean" });
					if (cachedValue) {
						return (await cachedValue.text()) === "true";
					}
					const stub = this.getDurableObjectStub(doId);
					const _hasBeenRevalidated = await stub.hasBeenRevalidated(tags, lastModified);
					//TODO: Do we want to cache the result if it has been revalidated ?
					// If we do so, we risk causing cache MISS even though it has been revalidated elsewhere
					// On the other hand revalidating a tag that is used in a lot of places will cause a lot of requests
					if (!_hasBeenRevalidated) {
						getCloudflareContext().ctx.waitUntil(
							this.putToRegionalCache({ doId, tags, type: "boolean" }, _hasBeenRevalidated)
						);
					}
					return _hasBeenRevalidated;
				})
			);
			return shardedTagRevalidationOutcomes.some((result) => result);
		} catch (e) {
			error("Error while checking revalidation", e);
			return false;
		}
	}

	/**
	 * This function writes the tags to the cache
	 * Due to the way shards and regional cache are implemented, the regional cache may not be properly invalidated
	 * @param tags
	 * @returns
	 */
	async writeTags(tags: string[]): Promise<void> {
		const { isDisabled } = await this.getConfig();
		if (isDisabled) return;
		const shardedTagGroups = this.groupTagsByDO({ tags, generateAllReplicas: true });
		// We want to use the same revalidation time for all tags
		const currentTime = Date.now();
		await Promise.all(
			shardedTagGroups.map(async ({ doId, tags }) => {
				await this.performWriteTagsWithRetry(doId, tags, currentTime);
			})
		);
		await purgeCacheByTags(tags);
	}

	async performWriteTagsWithRetry(doId: DOId, tags: string[], lastModified: number, retryNumber = 0) {
		try {
			const stub = this.getDurableObjectStub(doId);
			await stub.writeTags(tags, lastModified);
			// Depending on the shards and the tags, deleting from the regional cache will not work for every tag
			// We also need to delete both cache
			await Promise.all([
				this.deleteRegionalCache({ doId, tags, type: "boolean" }),
				this.deleteRegionalCache({ doId, tags, type: "number" }),
			]);
		} catch (e) {
			error("Error while writing tags", e);
			if (retryNumber >= this.maxWriteRetries) {
				error("Error while writing tags, too many retries");
				// Do we want to throw an error here ?
				await getCloudflareContext().env.NEXT_TAG_CACHE_DO_SHARDED_DLQ?.send({
					failingShardId: doId.key,
					failingTags: tags,
					lastModified,
				});
				return;
			}
			await this.performWriteTagsWithRetry(doId, tags, lastModified, retryNumber + 1);
		}
	}

	// Cache API
	async getCacheInstance() {
		if (!this.localCache && this.opts.regionalCache) {
			this.localCache = await caches.open("sharded-do-tag-cache");
		}
		return this.localCache;
	}

	getCacheUrlKey(opts: CacheTagKeyOptions): string {
		const { doId, tags, type } = opts;
		return `http://local.cache/shard/${doId.shardId}?type=${type}&tags=${encodeURIComponent(tags.join(";"))}`;
	}

	async getFromRegionalCache(opts: CacheTagKeyOptions) {
		try {
			if (!this.opts.regionalCache) return;
			const cache = await this.getCacheInstance();
			if (!cache) return;
			return cache.match(this.getCacheUrlKey(opts));
		} catch (e) {
			error("Error while fetching from regional cache", e);
		}
	}

	async putToRegionalCache(optsKey: CacheTagKeyOptions, value: number | boolean) {
		if (!this.opts.regionalCache) return;
		const cache = await this.getCacheInstance();
		if (!cache) return;
		const tags = optsKey.tags;
		await cache.put(
			this.getCacheUrlKey(optsKey),
			new Response(`${value}`, {
				headers: {
					"cache-control": `max-age=${this.opts.regionalCacheTtlSec ?? 5}`,
					...(tags.length > 0
						? {
								"cache-tag": tags.join(","),
							}
						: {}),
				},
			})
		);
	}

	async deleteRegionalCache(optsKey: CacheTagKeyOptions) {
		// We never want to crash because of the cache
		try {
			if (!this.opts.regionalCache) return;
			const cache = await this.getCacheInstance();
			if (!cache) return;
			await cache.delete(this.getCacheUrlKey(optsKey));
		} catch (e) {
			debugCache("Error while deleting from regional cache", e);
		}
	}
}

export default (opts?: ShardedDOTagCacheOptions) => new ShardedDOTagCache(opts);
