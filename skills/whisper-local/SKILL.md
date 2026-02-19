---
name: whisper-local
description: 本地语音识别工具。使用 OpenAI Whisper 本地模型进行音频转文字，支持离线运行、多种语言、时间戳输出。适用于"本地转录音频"、"Whisper识别"、"离线语音转文字"等查询。隐私友好，高准确率，支持大文件处理。
---

# OpenAI Whisper (Local)

Local speech-to-text using OpenAI Whisper models (offline, privacy-friendly).

## Purpose
Transcribe audio to text locally using Whisper models, without cloud API calls.

## Supported Features
- Offline transcription (no internet required)
- Multi-language support
- Multiple model sizes (tiny, base, small, medium, large)
- Timestamped transcriptions
- High accuracy
- Privacy-friendly (no data sent to cloud)

## Setup
Requires Whisper models downloaded locally (via whisper package or whisper.cpp)

## Input
Audio file path (MP3, WAV, M4A, etc.)

## Output
Transcribed text with optional timestamps and language detection
