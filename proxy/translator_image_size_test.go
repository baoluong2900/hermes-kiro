package proxy

// Regression: a screenshot whose base64 exceeded 5 MiB was forwarded verbatim
// and Kiro answered, after ~25s, with HTTP 400 IMAGE_SIZE_EXCEEDED. The
// gateway must shrink such images before upstream ever sees them.

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"math/rand"
	"testing"
)

func noisyPNGBase64(t *testing.T, side int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, side, side))
	rng := rand.New(rand.NewSource(1))
	for i := range img.Pix {
		img.Pix[i] = byte(rng.Intn(256))
	}
	var buf bytes.Buffer
	if err := (&png.Encoder{CompressionLevel: png.NoCompression}).Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestParseBase64Image_ShrinksOversizedImage(t *testing.T) {
	data := noisyPNGBase64(t, 1400) // ~10 MB base64
	if len(data) <= kiroImageMaxBase64 {
		t.Fatalf("fixture too small to exercise the limit: %d", len(data))
	}

	img := parseBase64Image(data, "png")
	if img == nil {
		t.Fatal("oversized image must not be dropped")
	}
	if len(img.Source.Bytes) > kiroImageMaxBase64 {
		t.Fatalf("image still over Kiro limit: %d > %d", len(img.Source.Bytes), kiroImageMaxBase64)
	}
	if img.Format != "jpeg" {
		t.Fatalf("expected re-encoded jpeg, got %q", img.Format)
	}
	raw, err := base64.StdEncoding.DecodeString(img.Source.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, format, err := image.Decode(bytes.NewReader(raw)); err != nil || format != "jpeg" {
		t.Fatalf("output not decodable jpeg: %v %q", err, format)
	}
}

func TestParseBase64Image_SmallImageUntouched(t *testing.T) {
	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 2, 2)))
	small := base64.StdEncoding.EncodeToString(buf.Bytes())
	img := parseBase64Image(small, "png")
	if img == nil || img.Format != "png" || img.Source.Bytes != small {
		t.Fatalf("small image must pass through unchanged: %+v", img)
	}
}
