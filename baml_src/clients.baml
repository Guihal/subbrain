client<llm> NimDefault {
  provider "openai-generic"
  options {
    base_url env.NIM_BASE_URL
    api_key env.NVIDIA_API_KEY
    model "deepseek-ai/deepseek-v4-flash"
  }
}
