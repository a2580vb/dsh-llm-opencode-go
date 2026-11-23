/**
 * Durable image references to request bytes.
 *
 * A catalog model that declares `image` input makes the runtime hand this
 * adapter real `ImageBlock` values instead of placeholders — but a block only
 * carries an attachment *reference*, never bytes. Turning that reference into
 * something a provider can read goes through the mounted attachment seam, which
 * is what this module does.
 *
 * The seam derives the request version from a target the adapter supplies: the
 * largest dimensions worth sending and the encoded-byte limits. Two spellings
 * of that target exist — the current seam validates `maxImageBytes` and
 * `imageTargetBytes` as positive integers, while an older one reads `maxPixels`
 * and `maxBytes` — and the service object carries no marker saying which it
 * speaks. Both pairs therefore travel together: a seam reads the pair it knows
 * and ignores the other, and neither generation refuses the request the way it
 * would a target that is missing its own fields.
 *
 * The resolver memoizes one promise per attachment id for the life of one
 * attempt, so repeated occurrences in one request read once. Nothing is cached
 * across requests, where the attachment provider's own variant cache applies.
 *
 * @module dsh-llm-opencode-go/model/images
 */

/** Default maximum width and height of one request image — 2048 x 2048. */
export const DEFAULT_IMAGE_MAX_DIMENSION = 2048

/** Default encoded-byte limit for one request image. */
export const DEFAULT_IMAGE_MAX_BYTES = 1_048_576

/** Raised when images are configured but no attachment seam is mounted. */
export class ImageAccessError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ImageAccessError'
    this.code = 'IMAGE_ACCESS_UNAVAILABLE'
  }
}

/**
 * Resolve image blocks for one image-capable route.
 *
 * @param {object} input - the resolver input.
 * @param {object | undefined} input.attachments - the mounted `attachments` service, when present.
 * @param {number} [input.maxDimension] - largest width and height sent, in pixels.
 * @param {number} [input.maxBytes] - encoded-byte limit per image.
 * @param {number} [input.imageTargetBytes] - preferred encoded size, clamped to `maxBytes`.
 * @param {AbortSignal} [input.signal] - cancellation.
 */
export class ImageResolver {
  constructor(input) {
    this.attachments = input.attachments
    this.maxDimension = input.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION
    this.maxBytes = input.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES
    this.imageTargetBytes = Math.min(input.imageTargetBytes ?? this.maxBytes, this.maxBytes)
    this.signal = input.signal
    /** @type {Map<string, Promise<{data: Uint8Array, mediaType: string, width: number, height: number} | undefined>>} */
    this.cache = new Map()
  }

  /** Whether a request that contains images can be served at all. */
  get available() {
    return this.attachments !== undefined
  }

  /**
   * The request-image bytes for one block.
   *
   * @param {object} block - a harness image block.
   * @returns {Promise<{data: Uint8Array, mediaType: string, width: number, height: number} | undefined>}
   *   the resolved bytes, or undefined when this occurrence cannot be resolved.
   */
  async resolve(block) {
    if (this.attachments === undefined) {
      throw new ImageAccessError(
        'dsh-llm-opencode-go: this model declares image input but no attachment provider is mounted,'
        + ' so a durable image reference cannot be read; remove "image" from the model\'s input list',
      )
    }
    const attachmentId = String(block?.attachment?.attachmentId ?? '')
    if (attachmentId === '') return undefined
    let pending = this.cache.get(attachmentId)
    if (pending === undefined) {
      pending = this.#read(block)
      this.cache.set(attachmentId, pending)
    }
    return pending
  }

  /**
   * The request-image target both seam generations understand.
   *
   * The dimensions are maxima: a source smaller than the route's cap keeps its
   * own size in that direction, so a small picture is never enlarged. A durable
   * reference always carries its intrinsic dimensions; a hand-built one may
   * not, and the route cap is then the only safe answer.
   *
   * @param {object} reference - the image attachment reference.
   * @returns {object} the target, carrying both the current and the older field spellings.
   */
  #target(reference) {
    const dimension = (value) => Number.isSafeInteger(value) && value > 0
      ? Math.min(this.maxDimension, value)
      : this.maxDimension
    return {
      width: dimension(reference?.width),
      height: dimension(reference?.height),
      maxImageBytes: this.maxBytes,
      imageTargetBytes: this.imageTargetBytes,
      // The same limits under the spellings an older attachment seam reads.
      // Both pairs travel because the service carries no marker saying which
      // generation it is; each ignores the pair it does not know.
      maxPixels: this.maxDimension * this.maxDimension,
      maxBytes: this.maxBytes,
    }
  }

  async #read(block) {
    const reference = block.attachment
    try {
      const version = await this.attachments.readImageRequest(
        reference,
        this.#target(reference),
        this.signal,
      )
      if (version?.data === undefined) return undefined
      return {
        data: version.data,
        mediaType: version.mediaType ?? reference.mediaType,
        width: version.width ?? reference.width,
        height: version.height ?? reference.height,
      }
    } catch (error) {
      if (error?.code === 'ATTACHMENT_PROJECTION_UNSUPPORTED') {
        throw new ImageAccessError(
          'dsh-llm-opencode-go: the mounted attachment provider cannot derive model-request images,'
          + ' so this route cannot accept image input',
        )
      }
      throw error
    }
  }
}

/** Base64 without a Buffer round trip's intermediate copies. */
function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/**
 * A data URL for the OpenAI-shaped protocols, whose image parts take a URL.
 *
 * @param {ImageResolver} resolver - the route's resolver.
 * @returns {(block: object) => Promise<string | undefined>} the factory.
 */
export function dataUrlFactory(resolver) {
  return async (block) => {
    const resolved = await resolver.resolve(block)
    if (resolved === undefined) return undefined
    return `data:${resolved.mediaType};base64,${toBase64(resolved.data)}`
  }
}

/**
 * A Messages-API image source for a resolver.
 *
 * @param {ImageResolver} resolver - the route's resolver.
 * @returns {(block: object) => Promise<{type: string, media_type: string, data: string} | undefined>} the factory.
 */
export function anthropicSourceFactory(resolver) {
  return async (block) => {
    const resolved = await resolver.resolve(block)
    if (resolved === undefined) return undefined
    return { type: 'base64', media_type: resolved.mediaType, data: toBase64(resolved.data) }
  }
}
