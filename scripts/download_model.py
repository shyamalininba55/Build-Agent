import os
import sys


def main():
    model_id = os.environ.get("LOCAL_MODEL_ID")
    if not model_id:
        raise ValueError("Set LOCAL_MODEL_ID before downloading the local model.")

    from huggingface_hub import snapshot_download

    model_path = snapshot_download(
        repo_id=model_id,
        cache_dir=os.environ.get("LOCAL_MODEL_CACHE_DIR") or None,
        token=os.environ.get("HF_TOKEN") or None,
    )
    print(f"Downloaded {model_id} to the Hugging Face model cache.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Model download failed: {error}", file=sys.stderr)
        raise
