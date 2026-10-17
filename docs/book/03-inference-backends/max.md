# Modular MAX

Modular MAX (formerly Modular Engine) is a high-performance inference runtime from Modular, the company behind the Mojo programming language. MAX uses a compiler-based approach to optimization rather than hand-tuned CUDA kernels, which means it can apply aggressive optimizations across the full compute graph.

## Requirements

- NVIDIA GPU with CUDA 12+ (CPU inference also supported)
- Ubuntu 22.04+ or macOS
- Python 3.9+

AMD GPU support is in preview as of early 2026.

## Installing MAX

```bash
# Install Modular CLI
curl -ssL https://magic.modular.com | bash
source ~/.bashrc

# Install MAX
magic add max
```

Or via pip:

```bash
pip install max
```

Verify:

```bash
max --version
```

## Starting MAX Serve

MAX provides an OpenAI-compatible serving endpoint:

```bash
max serve \
  --model-path Qwen/Qwen2.5-14B-Instruct \
  --host 0.0.0.0 \
  --port 8080
```

With a HuggingFace token (for gated models):

```bash
HF_TOKEN=hf_... max serve \
  --model-path meta-llama/Llama-3.1-8B-Instruct \
  --host 0.0.0.0 \
  --port 8080
```

Test:

```bash
curl http://localhost:8080/health
# {"status":"ok"}

curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen2.5-14B-Instruct",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 50
  }'
```

## How MAX Differs

**Compiler-based optimization**: vLLM and SGLang are written primarily in Python with custom CUDA kernels for hot paths. MAX compiles the model graph end-to-end using MLIR and applies optimizations that span operator boundaries — fusing attention + MLP, eliminating redundant data movement, etc. For well-supported architectures, this gives competitive or superior performance without requiring architecture-specific hand tuning.

**Mojo runtime**: The inference kernels are written in Mojo, which compiles to native code. This avoids Python GIL overhead and enables aggressive inlining that Python-based frameworks can't do.

**Continuous batching**: Like vLLM, MAX uses continuous batching to maximize GPU utilization across concurrent requests. New requests join an in-flight batch as soon as a slot is available rather than waiting for the current batch to complete.

## Throughput Benchmarks

On an NVIDIA H100 80GB serving Qwen2.5-14B-Instruct at 512 output tokens, approximate throughput:

| Backend | Tokens/second (single stream) | Tokens/second (16 concurrent) |
|---------|-------------------------------|-------------------------------|
| Ollama  | 85                            | 220                           |
| vLLM    | 120                           | 580                           |
| SGLang  | 125                           | 610                           |
| MAX     | 130                           | 640                           |

These numbers are illustrative. Actual performance depends heavily on model architecture, quantization, batch size, and hardware. Benchmark against your own workload.

## Quantization

MAX supports several quantization formats:

```bash
# AWQ quantization (fast, good quality)
max serve \
  --model-path Qwen/Qwen2.5-14B-Instruct-AWQ \
  --port 8080

# GPTQ
max serve \
  --model-path TheBloke/Qwen2.5-14B-GPTQ \
  --port 8080

# bitsandbytes (4-bit NF4)
max serve \
  --model-path Qwen/Qwen2.5-14B-Instruct \
  --quantization bnb-4bit \
  --port 8080
```

## Context Length

```bash
# Extend context beyond model default
max serve \
  --model-path Qwen/Qwen2.5-14B-Instruct \
  --max-length 32768 \
  --port 8080
```

## Key Environment Variables

```bash
# MAX server address
MODULAR_MAX_HOST=http://localhost:8080

# Model path
MAX_MODEL=Qwen/Qwen2.5-14B-Instruct

# HuggingFace token
HF_TOKEN=hf_your_token_here

# GPU device selection
CUDA_VISIBLE_DEVICES=0

# Number of GPU workers
MAX_NUM_GPUS=1
```

## Infernet Config

```json
{
  "backend": "max",
  "max_host": "http://localhost:8080",
  "max_model": "Qwen/Qwen2.5-14B-Instruct"
}
```

## Systemd Service

```ini
[Unit]
Description=Modular MAX Inference Server
After=network.target

[Service]
Type=simple
User=infernet
ExecStart=/home/infernet/.modular/bin/max serve \
  --model-path Qwen/Qwen2.5-14B-Instruct \
  --host 0.0.0.0 \
  --port 8080
Restart=always
RestartSec=10
Environment=CUDA_VISIBLE_DEVICES=0

[Install]
WantedBy=multi-user.target
```

## Model Support

MAX has strong support for:
- Qwen2, Qwen2.5 family
- Llama 3, Llama 3.1, Llama 3.2
- Mistral, Mixtral
- Phi-3, Phi-3.5
- Gemma 2

Check the [Modular docs](https://docs.modular.com/max/) for the current supported model list. For models not yet natively supported, MAX can often serve them via HuggingFace Transformers compatibility mode (slower but still works).
