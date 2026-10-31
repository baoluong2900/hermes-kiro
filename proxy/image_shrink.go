package proxy

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"strings"

	_ "image/gif" // register decoders for image.Decode
	_ "image/png"
)

// kiroImageMaxBase64 is Kiro's per-image cap. Upstream measures the base64
// string, not the decoded bytes ("image exceeds 5 MB maximum: 7842560 bytes >
// 5242880 bytes", reason IMAGE_SIZE_EXCEEDED), and only answers after ~25s of
// upload, so a large screenshot used to cost a slow, opaque 400.
const kiroImageMaxBase64 = 5 * 1024 * 1024

// shrinkImageToLimit re-encodes an oversized image as JPEG, halving its
// dimensions until the base64 fits under the Kiro cap. Returns the input
// unchanged when it already fits or cannot be decoded (upstream then reports
// the real reason). The returned format is "jpeg" whenever a re-encode happened.
//
// shortcut: nearest-neighbour downscale and alpha is flattened to black;
// upgrade to golang.org/x/image/draw if screenshot text becomes unreadable.
func shrinkImageToLimit(data, format string) (string, string) {
	if len(data) <= kiroImageMaxBase64 {
		return data, format
	}
	raw, err := decodeAnyBase64(data)
	if err != nil {
		return data, format
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return data, format
	}
	for i := 0; i < 6; i++ {
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err != nil {
			return data, format
		}
		out := base64.StdEncoding.EncodeToString(buf.Bytes())
		if len(out) <= kiroImageMaxBase64 {
			return out, "jpeg"
		}
		img = halveImage(img)
	}
	return data, format
}

func halveImage(src image.Image) image.Image {
	b := src.Bounds()
	w, h := b.Dx()/2, b.Dy()/2
	if w < 1 || h < 1 {
		return src
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			dst.Set(x, y, src.At(b.Min.X+x*2, b.Min.Y+y*2))
		}
	}
	return dst
}

func decodeAnyBase64(data string) ([]byte, error) {
	data = strings.TrimSpace(data)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if raw, err := enc.DecodeString(data); err == nil {
			return raw, nil
		}
	}
	_, err := base64.StdEncoding.DecodeString(data)
	return nil, err
}
