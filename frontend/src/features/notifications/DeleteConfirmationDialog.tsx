import { useTranslation } from "react-i18next";
import { Flex } from "@/components/ui/layout";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui";

interface DeleteConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export default function DeleteConfirmationDialog({
  open,
  title,
  description,
  saving,
  onOpenChange,
  onConfirm,
}: DeleteConfirmationDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <Flex gap="3" mt="4" justify="end">
          <DialogClose asChild>
            <Button variant="ghost">{t("common.cancel")}</Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={saving}>
            {saving ? t("common.deleting") : t("common.delete")}
          </Button>
        </Flex>
      </DialogContent>
    </Dialog>
  );
}
