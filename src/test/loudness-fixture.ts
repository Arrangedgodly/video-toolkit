/** COMMITTED loudnorm first-pass stderr fixture — byte-exact capture of
 * this machine's ffmpeg 9.0.1 ffmpeg-full running the measure-loudness
 * analysis invocation on a 0.5-amplitude 1 kHz sine (6 s, 44.1 kHz mono
 * pcm_s16le WAV):
 *   ffmpeg -nostdin -hide_banner -i tone.wav \
 *     -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -vn -f null -
 * Ground truth for parseLoudnormJson unit tests (JSON-block extraction
 * from noisy stderr is the tested part). Mirrors the xfade-help-fixture /
 * whisper-fixture precedent. NOT re-compared against live output (stderr
 * carries addresses/timings); live behavior is covered by the integration
 * tests on generated fixtures.
 */
export const LOUDNORM_STDERR_FIXTURE = "[aist#0:0/pcm_s16le @ 0x714c58180] Guessed Channel Layout: mono\nInput #0, wav, from 'tone05.wav':\n  Metadata:\n    encoder         : Lavf63.1.101\n  Duration: 00:00:06.00, bitrate: 705 kb/s\n  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, mono, s16, 705 kb/s\nStream mapping:\n  Stream #0:0 -> #0:0 (pcm_s16le (native) -> pcm_s16le (native))\nOutput #0, null, to 'pipe:':\n  Metadata:\n    encoder         : Lavf63.1.101\n  Stream #0:0: Audio: pcm_s16le, 192000 Hz, mono, s16, 3072 kb/s\n    Metadata:\n      encoder         : Lavc63.1.101 pcm_s16le\n[Parsed_loudnorm_0 @ 0x714c29680] \n{\n\t\"input_i\" : \"-9.05\",\n\t\"input_tp\" : \"-6.02\",\n\t\"input_lra\" : \"0.00\",\n\t\"input_thresh\" : \"-19.05\",\n\t\"output_i\" : \"-16.03\",\n\t\"output_tp\" : \"-12.97\",\n\t\"output_lra\" : \"0.00\",\n\t\"output_thresh\" : \"-26.03\",\n\t\"normalization_type\" : \"dynamic\",\n\t\"target_offset\" : \"0.03\"\n}\n[out#0/null @ 0x714c28e40] video:0KiB audio:2250KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown\nsize=N/A time=00:00:06.00 bitrate=N/A speed=69.4x elapsed=0:00:00.08    \n";
