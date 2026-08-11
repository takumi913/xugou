package config

var (
	ServerURL       string = ""
	Token           string = ""
	TokenFile       string = ""
	Interval        int    = 120
	CollectInterval int    = 60
	ReportInterval  int    = 60
	ProxyURL        string = ""
	// ConfigFilePath 本地配置文件路径（用于服务端下发配置的原子持久化，空则仅内存生效）
	ConfigFilePath string = ""
	// AgentVersion 探针自身版本（由 cmd 层在启动时注入，上报请求以 X-Agent-Version 携带）
	AgentVersion string = ""
	// SpoolDir 是不含凭据的持久化采样队列目录。
	SpoolDir string = ""
	// SpoolMaxBytes 限制本地持久化队列总大小，满额时优先删除最老的非 inflight 样本。
	SpoolMaxBytes int64 = 64 * 1024 * 1024
	// ReportMaxCompressedBytes 控制单个 gzip v4 请求的压缩后大小。
	ReportMaxCompressedBytes int = 64 * 1024
)
