#!/usr/bin/env python3
"""本地语音转写 — 复用 fcitx5-vinput 自带的 sherpa-onnx 运行时。

不引入任何新依赖：用 ctypes 直接调系统里已存在的 libsherpa-onnx-c-api.so，
模型用 vinput 输入法已经下载好的中英标点模型。用途是给微信语音转写做第二意见，
两边不一致时由 wechat-worker 标出来。

用法：
    python3 local-asr.py <audio.wav>

环境变量：
    SHERPA_C_API_LIB      sherpa-onnx C API 共享库路径（默认取 fcitx5-vinput 的）
    SHERPA_LIB_DIR        含 libonnxruntime.so 的目录，会被塞进 LD_LIBRARY_PATH
    VINPUT_ASR_MODEL_DIR  模型目录；缺省时在 vinput 模型目录下自动发现
    ASR_TAIL_PAD_S        尾部补静音秒数，默认 3.0

stdout 只输出识别文本；诊断信息一律走 stderr；失败时退出码非零。
"""

import ctypes
import glob
import os
import struct
import sys
import wave

DEFAULT_LIB = "/usr/lib/x86_64-linux-gnu/fcitx5-vinput/libsherpa-onnx-c-api.so"
DEFAULT_MODEL_ROOT = os.path.expanduser("~/.local/share/vinput/models/sherpa-onnx")
TARGET_RATE = 16000
TAIL_PAD_S = float(os.environ.get("ASR_TAIL_PAD_S", "3.0"))


# ── C API 结构体（对齐 sherpa-onnx 1.13.8 的 c-api.h，改版本要同步改这里）──────
class FeatureConfig(ctypes.Structure):
    _fields_ = [("sample_rate", ctypes.c_int32), ("feature_dim", ctypes.c_int32)]


class OnlineTransducerModelConfig(ctypes.Structure):
    _fields_ = [("encoder", ctypes.c_char_p), ("decoder", ctypes.c_char_p),
                ("joiner", ctypes.c_char_p)]


class OnlineParaformerModelConfig(ctypes.Structure):
    _fields_ = [("encoder", ctypes.c_char_p), ("decoder", ctypes.c_char_p)]


class OnlineZipformer2CtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OnlineNemoCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OnlineToneCtcModelConfig(ctypes.Structure):
    _fields_ = [("model", ctypes.c_char_p)]


class OnlineModelConfig(ctypes.Structure):
    _fields_ = [
        ("transducer", OnlineTransducerModelConfig),
        ("paraformer", OnlineParaformerModelConfig),
        ("zipformer2_ctc", OnlineZipformer2CtcModelConfig),
        ("tokens", ctypes.c_char_p),
        ("num_threads", ctypes.c_int32),
        ("provider", ctypes.c_char_p),
        ("debug", ctypes.c_int32),
        ("model_type", ctypes.c_char_p),
        ("modeling_unit", ctypes.c_char_p),
        ("bpe_vocab", ctypes.c_char_p),
        ("tokens_buf", ctypes.c_char_p),
        ("tokens_buf_size", ctypes.c_int32),
        ("nemo_ctc", OnlineNemoCtcModelConfig),
        ("t_one_ctc", OnlineToneCtcModelConfig),
    ]


class OnlineCtcFstDecoderConfig(ctypes.Structure):
    _fields_ = [("graph", ctypes.c_char_p), ("max_active", ctypes.c_int32)]


class HomophoneReplacerConfig(ctypes.Structure):
    _fields_ = [("dict_dir", ctypes.c_char_p), ("lexicon", ctypes.c_char_p),
                ("rule_fsts", ctypes.c_char_p)]


class OnlineRecognizerConfig(ctypes.Structure):
    _fields_ = [
        ("feat_config", FeatureConfig),
        ("model_config", OnlineModelConfig),
        ("decoding_method", ctypes.c_char_p),
        ("max_active_paths", ctypes.c_int32),
        ("enable_endpoint", ctypes.c_int32),
        ("rule1_min_trailing_silence", ctypes.c_float),
        ("rule2_min_trailing_silence", ctypes.c_float),
        ("rule3_min_utterance_length", ctypes.c_float),
        ("hotwords_file", ctypes.c_char_p),
        ("hotwords_score", ctypes.c_float),
        ("ctc_fst_decoder_config", OnlineCtcFstDecoderConfig),
        ("rule_fsts", ctypes.c_char_p),
        ("rule_fars", ctypes.c_char_p),
        ("blank_penalty", ctypes.c_float),
        ("hotwords_buf", ctypes.c_char_p),
        ("hotwords_buf_size", ctypes.c_int32),
        ("hr", HomophoneReplacerConfig),
    ]


class OnlineRecognizerResult(ctypes.Structure):
    _fields_ = [("text", ctypes.c_char_p),
                ("tokens", ctypes.c_char_p),
                ("tokens_arr", ctypes.POINTER(ctypes.c_char_p)),
                ("timestamps", ctypes.POINTER(ctypes.c_float)),
                ("count", ctypes.c_int32),
                ("json", ctypes.c_char_p)]


def find_model_dir():
    """优先用环境变量；否则在 vinput 模型目录下找含 encoder 的那个。"""
    explicit = os.environ.get("VINPUT_ASR_MODEL_DIR")
    if explicit:
        if not os.path.isfile(os.path.join(explicit, "encoder.int8.onnx")):
            raise SystemExit(f"VINPUT_ASR_MODEL_DIR 下没有 encoder.int8.onnx：{explicit}")
        return explicit
    for d in sorted(glob.glob(os.path.join(DEFAULT_MODEL_ROOT, "*"))):
        if os.path.isfile(os.path.join(d, "encoder.int8.onnx")):
            return d
    raise SystemExit(f"在 {DEFAULT_MODEL_ROOT} 下找不到 sherpa-onnx 模型目录")


def read_wav_mono16k(path):
    """读 WAV → float32 单声道 16k。非 16k 用线性插值重采样（够 ASR 用，避免引新依赖）。"""
    if not os.path.isfile(path):
        raise SystemExit(f"音频文件不存在：{path}")
    with open(path, "rb") as fh:
        if fh.read(4) != b"RIFF":
            raise SystemExit(f"不是 RIFF/WAV（SILK 转码失败时会落到这里）：{path}")
    with wave.open(path) as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"只支持 16-bit PCM，实际 {w.getsampwidth() * 8}-bit")
        nch, rate, n = w.getnchannels(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    samples = struct.unpack(f"<{n * nch}h", raw)
    if nch > 1:                                     # 多声道取第一条
        samples = samples[::nch]
    if rate != TARGET_RATE:                         # 线性插值重采样
        print(f"warning: {rate}Hz → {TARGET_RATE}Hz 线性重采样", file=sys.stderr)
        ratio = TARGET_RATE / rate
        out_len = int(len(samples) * ratio)
        samples = tuple(
            samples[min(int(i / ratio), len(samples) - 1)] for i in range(out_len)
        )
    buf = (ctypes.c_float * len(samples))(*(s / 32768.0 for s in samples))
    return TARGET_RATE, buf, len(samples)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("用法：local-asr.py <audio.wav>")
    wav_path = sys.argv[1]

    lib_path = os.environ.get("SHERPA_C_API_LIB", DEFAULT_LIB)
    if not os.path.isfile(lib_path):
        raise SystemExit(f"sherpa-onnx 共享库不存在：{lib_path}")
    model_dir = find_model_dir()

    # 先把 libonnxruntime.so 以 RTLD_GLOBAL 载进来，这样下面 dlopen sherpa 的
    # 时候能按 soname 命中，调用方无需设置 LD_LIBRARY_PATH。
    lib_dir = os.environ.get("SHERPA_LIB_DIR", os.path.dirname(lib_path))
    onnx_rt = os.path.join(lib_dir, "libonnxruntime.so")
    if os.path.isfile(onnx_rt):
        ctypes.CDLL(onnx_rt, mode=ctypes.RTLD_GLOBAL)

    try:
        lib = ctypes.CDLL(lib_path)
    except OSError as e:                            # 通常缺 libonnxruntime.so
        raise SystemExit(f"加载 sherpa-onnx 失败：{e}（检查 SHERPA_LIB_DIR）")

    lib.SherpaOnnxGetVersionStr.restype = ctypes.c_char_p

    cfg = OnlineRecognizerConfig()
    cfg.feat_config.sample_rate = TARGET_RATE
    cfg.feat_config.feature_dim = 80
    m = cfg.model_config
    m.transducer.encoder = os.path.join(model_dir, "encoder.int8.onnx").encode()
    m.transducer.decoder = os.path.join(model_dir, "decoder.onnx").encode()
    m.transducer.joiner = os.path.join(model_dir, "joiner.int8.onnx").encode()
    m.tokens = os.path.join(model_dir, "tokens.txt").encode()
    m.num_threads = 2
    m.provider = b"cpu"
    m.debug = 0
    m.model_type = b""
    m.modeling_unit = b"bpe"
    m.bpe_vocab = os.path.join(model_dir, "bpe.vocab").encode()
    cfg.decoding_method = b"greedy_search"
    cfg.max_active_paths = 4
    cfg.enable_endpoint = 0

    lib.SherpaOnnxCreateOnlineRecognizer.restype = ctypes.c_void_p
    lib.SherpaOnnxCreateOnlineRecognizer.argtypes = [ctypes.POINTER(OnlineRecognizerConfig)]
    recognizer = lib.SherpaOnnxCreateOnlineRecognizer(ctypes.byref(cfg))
    if not recognizer:
        raise SystemExit("创建 recognizer 失败（模型文件或配置不对）")
    print(f"sherpa-onnx {lib.SherpaOnnxGetVersionStr().decode()}", file=sys.stderr)

    lib.SherpaOnnxCreateOnlineStream.restype = ctypes.c_void_p
    lib.SherpaOnnxCreateOnlineStream.argtypes = [ctypes.c_void_p]
    stream = lib.SherpaOnnxCreateOnlineStream(recognizer)

    lib.SherpaOnnxOnlineStreamAcceptWaveform.argtypes = [
        ctypes.c_void_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_float), ctypes.c_int32]
    rate, buf, n = read_wav_mono16k(wav_path)
    lib.SherpaOnnxOnlineStreamAcceptWaveform(stream, rate, buf, n)

    # 流式 zipformer 的右上下文要靠尾部静音冲出来，否则末尾几个字会被吃掉。
    # 实测 0.6s 时 2.1s 的「你知道我是谁吗」只出到「你知道我是」。
    pad_n = int(rate * TAIL_PAD_S)
    silence = (ctypes.c_float * pad_n)(*([0.0] * pad_n))
    lib.SherpaOnnxOnlineStreamAcceptWaveform(stream, rate, silence, pad_n)
    lib.SherpaOnnxOnlineStreamInputFinished(stream)

    lib.SherpaOnnxIsOnlineStreamReady.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    lib.SherpaOnnxDecodeOnlineStream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    while lib.SherpaOnnxIsOnlineStreamReady(recognizer, stream):
        lib.SherpaOnnxDecodeOnlineStream(recognizer, stream)

    lib.SherpaOnnxGetOnlineStreamResult.restype = ctypes.POINTER(OnlineRecognizerResult)
    lib.SherpaOnnxGetOnlineStreamResult.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    result = lib.SherpaOnnxGetOnlineStreamResult(recognizer, stream)
    text = result.contents.text.decode("utf-8").strip()

    lib.SherpaOnnxDestroyOnlineStream(stream)
    lib.SherpaOnnxDestroyOnlineRecognizer(recognizer)

    if not text:
        raise SystemExit("识别结果为空")
    print(text)


if __name__ == "__main__":
    main()
