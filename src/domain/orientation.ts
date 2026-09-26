export function displayDimensions(stream: { width: number; height: number;
  tags?: { rotate?: number }; side_data_list?: Array<{ rotation?: number }> }) {
  const rotation = stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0;
  return Math.abs(rotation) % 180 === 90 ? { width: stream.height, height: stream.width } :
    { width: stream.width, height: stream.height };
}
