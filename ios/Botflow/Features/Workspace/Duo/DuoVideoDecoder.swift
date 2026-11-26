import CoreMedia
import CoreVideo
import Foundation
import Metal
import VideoToolbox

/// One decoded picture of a Duo panel, as a Metal texture the 3D view can draw.
struct DuoFrame: @unchecked Sendable {
    let texture: MTLTexture
    /// What the texture is a view of, if anything; kept so it stays valid while shown.
    let backing: AnyObject?
    /// The decoded picture itself (nil for a stand-in drawn by the app).
    let pixelBuffer: CVPixelBuffer?
}

/// Decodes one Duo panel's H.264 stream into Metal textures.
///
/// The single-screen devices hand their stream to an `AVSampleBufferDisplayLayer`,
/// which decodes and shows it. The Duo's pictures go on a 3D model instead, so
/// here the frames are decoded with VideoToolbox and wrapped as textures
/// without a copy.
final class DuoVideoDecoder {
    private let display: DuoDisplay
    private let parser = H264Decoder()
    private var session: VTDecompressionSession?
    private var sessionFormat: CMVideoFormatDescription?
    private var textureCache: CVMetalTextureCache?
    private let onFrame: @Sendable (DuoDisplay, DuoFrame) -> Void

    /// The Metal device shared by the decoders and the view that draws their textures.
    static let device: MTLDevice? = MTLCreateSystemDefaultDevice()

    init(display: DuoDisplay, onFrame: @escaping @Sendable (DuoDisplay, DuoFrame) -> Void) {
        self.display = display
        self.onFrame = onFrame
        if let device = Self.device {
            CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
        }
    }

    deinit { invalidate() }

    /// Call on one queue only (the controller's decode queue).
    func decode(_ accessUnit: Data, keyframe: Bool) {
        guard let sample = parser.sampleBuffer(from: accessUnit, keyframe: keyframe),
              let format = CMSampleBufferGetFormatDescription(sample) else { return }
        if session == nil || sessionFormat.map({ !CFEqual($0, format) }) ?? true {
            makeSession(for: format)
        }
        guard let session else { return }
        var info = VTDecodeInfoFlags()
        let status = VTDecompressionSessionDecodeFrame(session, sampleBuffer: sample, flags: [], infoFlagsOut: &info) { [weak self] status, _, imageBuffer, _, _ in
            guard status == noErr, let imageBuffer, let self else { return }
            self.deliver(imageBuffer)
        }
        if status != noErr {
            // A decode error: start over at the next keyframe.
            invalidate()
            parser.reset()
        }
    }

    func reset() {
        invalidate()
        parser.reset()
    }

    private func invalidate() {
        if let session {
            VTDecompressionSessionInvalidate(session)
        }
        session = nil
        sessionFormat = nil
    }

    private func makeSession(for format: CMVideoFormatDescription) {
        invalidate()
        // BGRA, backed by an IOSurface Metal can read directly.
        let attributes: [CFString: Any] = [
            kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
        ]
        var created: VTDecompressionSession?
        let status = VTDecompressionSessionCreate(
            allocator: kCFAllocatorDefault, formatDescription: format, decoderSpecification: nil,
            imageBufferAttributes: attributes as CFDictionary, outputCallback: nil, decompressionSessionOut: &created
        )
        guard status == noErr, let created else { return }
        // A live stream: no waiting on frames that will never be reordered.
        VTSessionSetProperty(created, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        session = created
        sessionFormat = format
    }

    private func deliver(_ pixelBuffer: CVPixelBuffer) {
        guard let textureCache else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer)
        var wrapped: CVMetalTexture?
        // sRGB, so the values come out of the renderer as they went in.
        let status = CVMetalTextureCacheCreateTextureFromImage(
            kCFAllocatorDefault, textureCache, pixelBuffer, nil, .bgra8Unorm_srgb, width, height, 0, &wrapped
        )
        guard status == kCVReturnSuccess, let wrapped, let texture = CVMetalTextureGetTexture(wrapped) else { return }
        onFrame(display, DuoFrame(texture: texture, backing: wrapped, pixelBuffer: pixelBuffer))
    }
}
