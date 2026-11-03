import unittest

from local_model_worker import _tokenize_messages


class ChatTemplateTokenizer:
    chat_template = "template"

    def __init__(self):
        self.call = None

    def apply_chat_template(self, messages, **options):
        self.call = (messages, options)
        return {"input_ids": "encoded"}


class FailingChatTemplateTokenizer(ChatTemplateTokenizer):
    def __init__(self):
        super().__init__()
        self.plain_prompt = None

    def apply_chat_template(self, messages, **options):
        raise TypeError(
            "TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, InputSequence]]"
        )

    def __call__(self, prompt, **options):
        self.plain_prompt = (prompt, options)
        return {"input_ids": "plain-encoded"}


class PlainTokenizer:
    chat_template = None

    def __init__(self):
        self.call = None

    def __call__(self, prompt, **options):
        self.call = (prompt, options)
        return {"input_ids": "encoded"}


class TokenizeMessagesTests(unittest.TestCase):
    def test_chat_template_returns_encoded_inputs_directly(self):
        tokenizer = ChatTemplateTokenizer()
        messages = [{"role": "user", "content": "Make the background dark."}]

        inputs = _tokenize_messages(tokenizer, messages)

        self.assertEqual(inputs, {"input_ids": "encoded"})
        self.assertEqual(tokenizer.call, (messages, {
            "tokenize": True,
            "add_generation_prompt": True,
            "return_tensors": "pt",
            "return_dict": True,
        }))

    def test_plain_tokenizer_receives_a_string_prompt(self):
        tokenizer = PlainTokenizer()
        messages = [
            {"role": "system", "content": "Follow project conventions."},
            {"role": "user", "content": "Make the background dark."},
        ]

        inputs = _tokenize_messages(tokenizer, messages)

        self.assertEqual(inputs, {"input_ids": "encoded"})
        self.assertEqual(tokenizer.call, (
            "Follow project conventions.\n\nMake the background dark.",
            {"return_tensors": "pt"},
        ))

    def test_text_encode_input_error_falls_back_to_plain_string(self):
        tokenizer = FailingChatTemplateTokenizer()
        messages = [
            {"role": "system", "content": "Follow project conventions."},
            {"role": "user", "content": "Make the background dark. \ud800"},
        ]

        inputs = _tokenize_messages(tokenizer, messages)

        self.assertEqual(inputs, {"input_ids": "plain-encoded"})
        self.assertEqual(tokenizer.plain_prompt, (
            "Follow project conventions.\n\nMake the background dark. ?",
            {"return_tensors": "pt"},
        ))


if __name__ == "__main__":
    unittest.main()
