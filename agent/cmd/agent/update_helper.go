package agent

import (
	"github.com/spf13/cobra"
	"github.com/xugou/agent/pkg/selfmgmt"
)

func init() {
	var parentPID int
	var source, target, expected string
	command := &cobra.Command{
		Use:    "update-helper",
		Hidden: true,
		Args:   cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return selfmgmt.RunWindowsUpdateHelper(parentPID, source, target, expected)
		},
	}
	command.Flags().IntVar(&parentPID, "parent-pid", 0, "parent process id")
	command.Flags().StringVar(&source, "source", "", "verified update payload")
	command.Flags().StringVar(&target, "target", "", "installed executable")
	command.Flags().StringVar(&expected, "expected", "", "expected semantic version")
	_ = command.MarkFlagRequired("parent-pid")
	_ = command.MarkFlagRequired("source")
	_ = command.MarkFlagRequired("target")
	_ = command.MarkFlagRequired("expected")
	rootCmd.AddCommand(command)
}
