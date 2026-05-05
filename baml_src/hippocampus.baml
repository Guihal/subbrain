class HippocampusWrite {
  layer "shared" | "context"
  category string
  content string
  tags string
  confidence float
  expires_at int?
  supersedes string[]?
}

class TaskAdd {
  title string
  description string?
  priority "low" | "normal" | "high"
  due_at int?
  tags string?
}
