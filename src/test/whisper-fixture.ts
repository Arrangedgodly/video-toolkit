/** Committed whisper-cli `-ojf` fixture (T10) — captured verbatim 2026-09-04 from
 * the R2-committed invocation on THIS build (whisper-cpp 1.9.2, ggml-base.en.bin):
 *   say x3 -> ffmpeg concat -> 16 kHz mono speech.wav (14.0 s) ->
 *   whisper-cli -m .video-agent/models/ggml-base.en.bin -f speech.wav -ojf -of p2
 * Offsets are integer MILLISECONDS (R2 contract: docs/ultron/research/r2-whisper-word-timestamps.md).
 * Unit tests parse THIS text; no live whisper-cli in unit tests. */
export const WHISPER_OJF_FIXTURE = String.raw`{
	"systeminfo": "WHISPER : COREML = 0 | OPENVINO = 0 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 | ARM_FMA = 1 | MATMUL_INT8 = 1 | DOTPROD = 1 | ACCELERATE = 1 | OPENMP = 1 | REPACK = 1 | ",
	"model": {
		"type": "base",
		"multilingual": false,
		"vocab": 51864,
		"audio": {
			"ctx": 1500,
			"state": 512,
			"head": 8,
			"layer": 6
		},
		"text": {
			"ctx": 448,
			"state": 512,
			"head": 8,
			"layer": 6
		},
		"mels": 80,
		"ftype": 1
	},
	"params": {
		"model": "/Users/arrangedgodly/Documents/Projects/general/video-toolkit/.video-agent/models/ggml-base.en.bin",
		"language": "en",
		"translate": false
	},
	"result": {
		"language": "en"
	},
	"transcription": [
		{
			"timestamps": {
				"from": "00:00:00,000",
				"to": "00:00:03,960"
			},
			"offsets": {
				"from": 0,
				"to": 3960
			},
			"text": " Um, you know, I was basically thinking about the alignment problem.",
			"tokens": [
				{
					"text": "[_BEG_]",
					"timestamps": {
						"from": "00:00:00,000",
						"to": "00:00:00,000"
					},
					"offsets": {
						"from": 0,
						"to": 0
					},
					"id": 50363,
					"p": 0.974214,
					"t_dtw": -1
				},
				{
					"text": " Um",
					"timestamps": {
						"from": "00:00:00,010",
						"to": "00:00:00,140"
					},
					"offsets": {
						"from": 10,
						"to": 140
					},
					"id": 21039,
					"p": 0.641438,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:00,140",
						"to": "00:00:00,270"
					},
					"offsets": {
						"from": 140,
						"to": 270
					},
					"id": 11,
					"p": 0.884089,
					"t_dtw": -1
				},
				{
					"text": " you",
					"timestamps": {
						"from": "00:00:00,400",
						"to": "00:00:00,500"
					},
					"offsets": {
						"from": 400,
						"to": 500
					},
					"id": 345,
					"p": 0.956061,
					"t_dtw": -1
				},
				{
					"text": " know",
					"timestamps": {
						"from": "00:00:00,500",
						"to": "00:00:00,790"
					},
					"offsets": {
						"from": 500,
						"to": 790
					},
					"id": 760,
					"p": 0.998746,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:00,790",
						"to": "00:00:00,840"
					},
					"offsets": {
						"from": 790,
						"to": 840
					},
					"id": 11,
					"p": 0.786787,
					"t_dtw": -1
				},
				{
					"text": " I",
					"timestamps": {
						"from": "00:00:00,990",
						"to": "00:00:01,010"
					},
					"offsets": {
						"from": 990,
						"to": 1010
					},
					"id": 314,
					"p": 0.971395,
					"t_dtw": -1
				},
				{
					"text": " was",
					"timestamps": {
						"from": "00:00:01,010",
						"to": "00:00:01,180"
					},
					"offsets": {
						"from": 1010,
						"to": 1180
					},
					"id": 373,
					"p": 0.997763,
					"t_dtw": -1
				},
				{
					"text": " basically",
					"timestamps": {
						"from": "00:00:01,180",
						"to": "00:00:01,630"
					},
					"offsets": {
						"from": 1180,
						"to": 1630
					},
					"id": 6209,
					"p": 0.973127,
					"t_dtw": -1
				},
				{
					"text": " thinking",
					"timestamps": {
						"from": "00:00:01,700",
						"to": "00:00:02,180"
					},
					"offsets": {
						"from": 1700,
						"to": 2180
					},
					"id": 3612,
					"p": 0.988725,
					"t_dtw": -1
				},
				{
					"text": " about",
					"timestamps": {
						"from": "00:00:02,180",
						"to": "00:00:02,360"
					},
					"offsets": {
						"from": 2180,
						"to": 2360
					},
					"id": 546,
					"p": 0.957998,
					"t_dtw": -1
				},
				{
					"text": " the",
					"timestamps": {
						"from": "00:00:02,440",
						"to": "00:00:02,550"
					},
					"offsets": {
						"from": 2440,
						"to": 2550
					},
					"id": 262,
					"p": 0.979419,
					"t_dtw": -1
				},
				{
					"text": " alignment",
					"timestamps": {
						"from": "00:00:02,550",
						"to": "00:00:02,890"
					},
					"offsets": {
						"from": 2550,
						"to": 2890
					},
					"id": 19114,
					"p": 0.974402,
					"t_dtw": -1
				},
				{
					"text": " problem",
					"timestamps": {
						"from": "00:00:03,010",
						"to": "00:00:03,350"
					},
					"offsets": {
						"from": 3010,
						"to": 3350
					},
					"id": 1917,
					"p": 0.992455,
					"t_dtw": -1
				},
				{
					"text": ".",
					"timestamps": {
						"from": "00:00:03,960",
						"to": "00:00:03,960"
					},
					"offsets": {
						"from": 3960,
						"to": 3960
					},
					"id": 13,
					"p": 0.880736,
					"t_dtw": -1
				},
				{
					"text": "[_TT_198]",
					"timestamps": {
						"from": "00:00:03,960",
						"to": "00:00:03,960"
					},
					"offsets": {
						"from": 3960,
						"to": 3960
					},
					"id": 50561,
					"p": 0.0205616,
					"t_dtw": -1
				}
			]
		},
		{
			"timestamps": {
				"from": "00:00:04,320",
				"to": "00:00:09,360"
			},
			"offsets": {
				"from": 4320,
				"to": 9360
			},
			"text": " So basically, we need to, uh, measure the actual timing of each word.",
			"tokens": [
				{
					"text": " So",
					"timestamps": {
						"from": "00:00:04,320",
						"to": "00:00:04,320"
					},
					"offsets": {
						"from": 4320,
						"to": 4320
					},
					"id": 1406,
					"p": 0.975005,
					"t_dtw": -1
				},
				{
					"text": " basically",
					"timestamps": {
						"from": "00:00:04,330",
						"to": "00:00:05,150"
					},
					"offsets": {
						"from": 4330,
						"to": 5150
					},
					"id": 6209,
					"p": 0.836061,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:05,310",
						"to": "00:00:05,400"
					},
					"offsets": {
						"from": 5310,
						"to": 5400
					},
					"id": 11,
					"p": 0.864657,
					"t_dtw": -1
				},
				{
					"text": " we",
					"timestamps": {
						"from": "00:00:05,400",
						"to": "00:00:05,560"
					},
					"offsets": {
						"from": 5400,
						"to": 5560
					},
					"id": 356,
					"p": 0.967418,
					"t_dtw": -1
				},
				{
					"text": " need",
					"timestamps": {
						"from": "00:00:05,700",
						"to": "00:00:06,080"
					},
					"offsets": {
						"from": 5700,
						"to": 6080
					},
					"id": 761,
					"p": 0.998658,
					"t_dtw": -1
				},
				{
					"text": " to",
					"timestamps": {
						"from": "00:00:06,080",
						"to": "00:00:06,320"
					},
					"offsets": {
						"from": 6080,
						"to": 6320
					},
					"id": 284,
					"p": 0.99782,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:06,320",
						"to": "00:00:06,400"
					},
					"offsets": {
						"from": 6320,
						"to": 6400
					},
					"id": 11,
					"p": 0.430257,
					"t_dtw": -1
				},
				{
					"text": " uh",
					"timestamps": {
						"from": "00:00:06,400",
						"to": "00:00:06,680"
					},
					"offsets": {
						"from": 6400,
						"to": 6680
					},
					"id": 21480,
					"p": 0.362597,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:06,760",
						"to": "00:00:07,080"
					},
					"offsets": {
						"from": 6760,
						"to": 7080
					},
					"id": 11,
					"p": 0.852336,
					"t_dtw": -1
				},
				{
					"text": " measure",
					"timestamps": {
						"from": "00:00:07,080",
						"to": "00:00:07,560"
					},
					"offsets": {
						"from": 7080,
						"to": 7560
					},
					"id": 3953,
					"p": 0.969456,
					"t_dtw": -1
				},
				{
					"text": " the",
					"timestamps": {
						"from": "00:00:07,560",
						"to": "00:00:07,690"
					},
					"offsets": {
						"from": 7560,
						"to": 7690
					},
					"id": 262,
					"p": 0.996884,
					"t_dtw": -1
				},
				{
					"text": " actual",
					"timestamps": {
						"from": "00:00:08,170",
						"to": "00:00:08,170"
					},
					"offsets": {
						"from": 8170,
						"to": 8170
					},
					"id": 4036,
					"p": 0.998776,
					"t_dtw": -1
				},
				{
					"text": " timing",
					"timestamps": {
						"from": "00:00:08,580",
						"to": "00:00:08,580"
					},
					"offsets": {
						"from": 8580,
						"to": 8580
					},
					"id": 10576,
					"p": 0.993491,
					"t_dtw": -1
				},
				{
					"text": " of",
					"timestamps": {
						"from": "00:00:08,660",
						"to": "00:00:08,710"
					},
					"offsets": {
						"from": 8660,
						"to": 8710
					},
					"id": 286,
					"p": 0.996274,
					"t_dtw": -1
				},
				{
					"text": " each",
					"timestamps": {
						"from": "00:00:08,760",
						"to": "00:00:08,950"
					},
					"offsets": {
						"from": 8760,
						"to": 8950
					},
					"id": 1123,
					"p": 0.999617,
					"t_dtw": -1
				},
				{
					"text": " word",
					"timestamps": {
						"from": "00:00:09,010",
						"to": "00:00:09,180"
					},
					"offsets": {
						"from": 9010,
						"to": 9180
					},
					"id": 1573,
					"p": 0.997956,
					"t_dtw": -1
				},
				{
					"text": ".",
					"timestamps": {
						"from": "00:00:09,300",
						"to": "00:00:09,360"
					},
					"offsets": {
						"from": 9300,
						"to": 9360
					},
					"id": 13,
					"p": 0.899625,
					"t_dtw": -1
				},
				{
					"text": "[_TT_468]",
					"timestamps": {
						"from": "00:00:09,360",
						"to": "00:00:09,360"
					},
					"offsets": {
						"from": 9360,
						"to": 9360
					},
					"id": 50831,
					"p": 0.0449288,
					"t_dtw": -1
				}
			]
		},
		{
			"timestamps": {
				"from": "00:00:09,760",
				"to": "00:00:14,000"
			},
			"offsets": {
				"from": 9760,
				"to": 14000
			},
			"text": " Right, so um, let's move on to the next topic. You know what I mean.",
			"tokens": [
				{
					"text": " Right",
					"timestamps": {
						"from": "00:00:09,770",
						"to": "00:00:09,800"
					},
					"offsets": {
						"from": 9770,
						"to": 9800
					},
					"id": 6498,
					"p": 0.984198,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:09,800",
						"to": "00:00:09,970"
					},
					"offsets": {
						"from": 9800,
						"to": 9970
					},
					"id": 11,
					"p": 0.698836,
					"t_dtw": -1
				},
				{
					"text": " so",
					"timestamps": {
						"from": "00:00:09,970",
						"to": "00:00:10,030"
					},
					"offsets": {
						"from": 9970,
						"to": 10030
					},
					"id": 523,
					"p": 0.984476,
					"t_dtw": -1
				},
				{
					"text": " um",
					"timestamps": {
						"from": "00:00:10,160",
						"to": "00:00:10,310"
					},
					"offsets": {
						"from": 10160,
						"to": 10310
					},
					"id": 23781,
					"p": 0.804925,
					"t_dtw": -1
				},
				{
					"text": ",",
					"timestamps": {
						"from": "00:00:10,310",
						"to": "00:00:10,470"
					},
					"offsets": {
						"from": 10310,
						"to": 10470
					},
					"id": 11,
					"p": 0.956795,
					"t_dtw": -1
				},
				{
					"text": " let",
					"timestamps": {
						"from": "00:00:10,470",
						"to": "00:00:10,600"
					},
					"offsets": {
						"from": 10470,
						"to": 10600
					},
					"id": 1309,
					"p": 0.982744,
					"t_dtw": -1
				},
				{
					"text": "'s",
					"timestamps": {
						"from": "00:00:10,750",
						"to": "00:00:10,910"
					},
					"offsets": {
						"from": 10750,
						"to": 10910
					},
					"id": 338,
					"p": 0.996835,
					"t_dtw": -1
				},
				{
					"text": " move",
					"timestamps": {
						"from": "00:00:10,910",
						"to": "00:00:11,260"
					},
					"offsets": {
						"from": 10910,
						"to": 11260
					},
					"id": 1445,
					"p": 0.998546,
					"t_dtw": -1
				},
				{
					"text": " on",
					"timestamps": {
						"from": "00:00:11,260",
						"to": "00:00:11,390"
					},
					"offsets": {
						"from": 11260,
						"to": 11390
					},
					"id": 319,
					"p": 0.881698,
					"t_dtw": -1
				},
				{
					"text": " to",
					"timestamps": {
						"from": "00:00:11,460",
						"to": "00:00:11,550"
					},
					"offsets": {
						"from": 11460,
						"to": 11550
					},
					"id": 284,
					"p": 0.997238,
					"t_dtw": -1
				},
				{
					"text": " the",
					"timestamps": {
						"from": "00:00:11,640",
						"to": "00:00:11,860"
					},
					"offsets": {
						"from": 11640,
						"to": 11860
					},
					"id": 262,
					"p": 0.997461,
					"t_dtw": -1
				},
				{
					"text": " next",
					"timestamps": {
						"from": "00:00:11,860",
						"to": "00:00:12,210"
					},
					"offsets": {
						"from": 11860,
						"to": 12210
					},
					"id": 1306,
					"p": 0.999582,
					"t_dtw": -1
				},
				{
					"text": " topic",
					"timestamps": {
						"from": "00:00:12,210",
						"to": "00:00:12,640"
					},
					"offsets": {
						"from": 12210,
						"to": 12640
					},
					"id": 7243,
					"p": 0.999731,
					"t_dtw": -1
				},
				{
					"text": ".",
					"timestamps": {
						"from": "00:00:12,640",
						"to": "00:00:13,000"
					},
					"offsets": {
						"from": 12640,
						"to": 13000
					},
					"id": 13,
					"p": 0.785649,
					"t_dtw": -1
				},
				{
					"text": " You",
					"timestamps": {
						"from": "00:00:13,000",
						"to": "00:00:13,130"
					},
					"offsets": {
						"from": 13000,
						"to": 13130
					},
					"id": 921,
					"p": 0.529513,
					"t_dtw": -1
				},
				{
					"text": " know",
					"timestamps": {
						"from": "00:00:13,360",
						"to": "00:00:13,360"
					},
					"offsets": {
						"from": 13360,
						"to": 13360
					},
					"id": 760,
					"p": 0.998997,
					"t_dtw": -1
				},
				{
					"text": " what",
					"timestamps": {
						"from": "00:00:13,360",
						"to": "00:00:13,570"
					},
					"offsets": {
						"from": 13360,
						"to": 13570
					},
					"id": 644,
					"p": 0.998298,
					"t_dtw": -1
				},
				{
					"text": " I",
					"timestamps": {
						"from": "00:00:13,570",
						"to": "00:00:13,620"
					},
					"offsets": {
						"from": 13570,
						"to": 13620
					},
					"id": 314,
					"p": 0.997995,
					"t_dtw": -1
				},
				{
					"text": " mean",
					"timestamps": {
						"from": "00:00:13,620",
						"to": "00:00:13,830"
					},
					"offsets": {
						"from": 13620,
						"to": 13830
					},
					"id": 1612,
					"p": 0.999554,
					"t_dtw": -1
				},
				{
					"text": ".",
					"timestamps": {
						"from": "00:00:14,000",
						"to": "00:00:14,000"
					},
					"offsets": {
						"from": 14000,
						"to": 14000
					},
					"id": 13,
					"p": 0.909202,
					"t_dtw": -1
				},
				{
					"text": "[_TT_700]",
					"timestamps": {
						"from": "00:00:14,000",
						"to": "00:00:14,000"
					},
					"offsets": {
						"from": 14000,
						"to": 14000
					},
					"id": 51063,
					"p": 0.0313566,
					"t_dtw": -1
				}
			]
		}
	]
}
`;
