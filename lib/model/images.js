/**
 * Durable image references to request bytes.
 *
 * A catalog model that declares `image` input makes the runtime hand this
 * adapter real `ImageBlock` values instead of placeholders — but a block only
 * carries an attachment *reference*, never bytes. Turning that reference into
 * something a provider can read goes through the mounted attachment seam, which
 * is what this module does.
 *
 * Nothing here is cached by the adapter: the attachment provider already keys
 * its request-image variants by attachment and target, so a second lookup for
 * the same occurrence is served from its own cache.
 *
 * @module dsh-llm-opencode-go/model/images
 */

/** Default total-pixel budget for one request image, matching the pi-ai adapter. */
export const DEFAULT_IMAGE_PIXEL_BUDGET = 4_194_304

/** Default encoded-byte target for one request image. */
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
 * @param {number} [input.pixelBudget] - total-pixel budget per image.
 * @param {number} [input.maxBytes] - encoded-byte target per image.
 * @param {AbortSignal} [input.signal] - cancellation.
 */
export class ImageResolver {
  constructor(input) {
    this.attachments = input.attachments
    this.pixelBudget = input.pixelBudget ?? DEFAULT_IMAGE_PIXEL_BUDGET
    this.maxBytes = input.maxBytes ?? DEFAULT_IMAGE_MAX_BYTES
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

  async #read(block) {
    const reference = block.attachment
    try {
      const version = await this.attachments.readImageRequest(reference, {
        width: reference.width,
        height: reference.height,
        maxPixels: this.pixelBudget,
        maxBytes: this.maxBytes,
      }, this.signal)
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
