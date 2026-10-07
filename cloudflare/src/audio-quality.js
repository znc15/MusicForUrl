// Packed Audio supports MP3, so an old lossless setting uses the highest MP3 level.
function mp3Quality(value) {
  const quality = String(value || 'low').trim().toLowerCase();
  if (quality === 'lossless') return 'high';
  return ['low', 'medium', 'high'].includes(quality) ? quality : 'low';
}

export { mp3Quality };
