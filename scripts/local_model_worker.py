import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


_model = None
_tokenizer = None
_adapter_temp_dir = None


def _prepare_adapter(adapter_path):
    global _adapter_temp_dir
    path = Path(adapter_path).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Local adapter not found: {path}")
    if path.is_dir():
        return path
    if not zipfile.is_zipfile(path):
        raise ValueError("LOCAL_ADAPTER_PATH must point to an adapter directory or ZIP archive.")

    _adapter_temp_dir = tempfile.TemporaryDirectory(prefix="build-agent-adapter-")
    target = Path(_adapter_temp_dir.name).resolve()
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            member = PurePosixPath(info.filename)
            if member.is_absolute() or ".." in member.parts:
                raise ValueError("Adapter archive contains an unsafe path.")
            parts = member.parts[1:] if member.parts and member.parts[0] == "adapter" else member.parts
            if not parts:
                continue
            destination = target.joinpath(*parts).resolve()
            if target not in destination.parents and destination != target:
                raise ValueError("Adapter archive contains a path outside its extraction directory.")
            if info.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(info) as source, destination.open("wb") as output:
                    output.write(source.read())
    return target


def _load_model():
    global _model, _tokenizer
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    model_id = os.environ.get("LOCAL_MODEL_ID")
    adapter_path = os.environ.get("LOCAL_ADAPTER_PATH") or os.environ.get("LOCAL_ADAPTER_ZIP")
    if model_id:
        from huggingface_hub import snapshot_download

        model_path = snapshot_download(
            repo_id=model_id,
            cache_dir=os.environ.get("LOCAL_MODEL_CACHE_DIR") or None,
            token=os.environ.get("HF_TOKEN") or None,
        )
        adapter_dir = None
    else:
        base_path = os.environ.get("LOCAL_BASE_MODEL_PATH")
        if not base_path or not adapter_path:
            raise ValueError("Set LOCAL_MODEL_ID or both LOCAL_BASE_MODEL_PATH and LOCAL_ADAPTER_PATH (or LOCAL_ADAPTER_ZIP).")
        if not Path(base_path).expanduser().is_dir():
            raise FileNotFoundError(f"Local base model directory not found: {base_path}")
        model_path = base_path
        adapter_dir = _prepare_adapter(adapter_path)

    tokenizer_path = adapter_dir or model_path
    _tokenizer = AutoTokenizer.from_pretrained(str(tokenizer_path), local_files_only=True)
    dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    base_model = AutoModelForCausalLM.from_pretrained(
        model_path,
        torch_dtype=dtype,
        device_map="auto",
        low_cpu_mem_usage=True,
        local_files_only=True,
    )
    if adapter_dir:
        from peft import PeftModel

        base_model = PeftModel.from_pretrained(base_model, str(adapter_dir), is_trainable=False)
    _model = base_model
    _model.eval()


def _tokenize_messages(tokenizer, messages):
    messages = [
        {
            **message,
            "content": message["content"].encode("utf-8", errors="replace").decode("utf-8"),
        }
        for message in messages
    ]
    if getattr(tokenizer, "chat_template", None):
        try:
            return tokenizer.apply_chat_template(
                messages,
                tokenize=True,
                add_generation_prompt=True,
                return_tensors="pt",
                return_dict=True,
            )
        except TypeError as error:
            if "TextEncodeInput" not in str(error):
                raise

    prompt = "\n\n".join(message["content"] for message in messages)
    try:
        return tokenizer(prompt, return_tensors="pt")
    except Exception as error:
        raise RuntimeError(f"Local tokenizer could not encode the plain-text prompt: {error}") from error


def _generate(request):
    if _model is None:
        _load_model()

    if not isinstance(request.get("system"), str) or not isinstance(request.get("user"), str):
        raise TypeError("Local model system and user prompts must be strings.")

    messages = [
        {"role": "system", "content": request["system"]},
        {"role": "user", "content": request["user"]},
    ]
    inputs = _tokenize_messages(_tokenizer, messages)
    input_device = _model.get_input_embeddings().weight.device
    inputs = {key: value.to(input_device) for key, value in inputs.items()}
    max_tokens = int(request["maxTokens"])
    context_limit = getattr(_model.config, "max_position_embeddings", None)
    if context_limit:
        remaining_context = context_limit - inputs["input_ids"].shape[1]
        if remaining_context < 1:
            raise ValueError(f"Prompt exceeds the local model context limit of {context_limit} tokens.")
        max_tokens = min(max_tokens, remaining_context)
    import torch

    with torch.inference_mode():
        output = _model.generate(
            **inputs,
            max_new_tokens=max_tokens,
            do_sample=True,
            temperature=0.2,
            pad_token_id=_tokenizer.eos_token_id,
        )
    generated = output[0, inputs["input_ids"].shape[1]:]
    reached_limit = generated.numel() >= max_tokens
    ended_with_eos = (
        _tokenizer.eos_token_id is not None
        and bool((generated == _tokenizer.eos_token_id).any().item())
    )
    if reached_limit and not ended_with_eos:
        raise ValueError("AI response was truncated by the token limit; increase the configured output budget and retry.")
    return _tokenizer.decode(generated, skip_special_tokens=True)


def main():
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            text = _generate(request)
            response = {"id": request.get("id"), "text": text}
        except Exception as error:
            response = {"id": request.get("id"), "error": str(error)}
        sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
