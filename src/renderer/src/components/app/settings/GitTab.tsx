import { memo } from "react";
import type { AppSettings, AvailableModel, ModelListReport } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { ModelPicker } from "../../session/ComposerComponents";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingRow, SettingSwitchRow, SettingTextarea } from "./SettingRows";

type GitTabProps = {
  draft: AppSettings;
  updateDraft: (patch: Partial<AppSettings>) => void;
  isDirty: (field: keyof AppSettings) => boolean;
  gitModels: AvailableModel[];
  gitModelsReport: ModelListReport | null;
  gitModelsRefreshing: boolean;
  onRefreshGitModels: () => void;
  gitModelPickerOpen: boolean;
  onOpenGitModelPicker: () => void;
  onCloseGitModelPicker: () => void;
  onPickGitModel: (model: AvailableModel) => void;
  onToggleGitModelFavorite: (provider: string, modelId: string) => void;
};

/**
 * 设置弹框「Git」tab（原为常用设置内区块，单独成 tab 便于高频访问）。
 * 区块 id 保留 settings-section-git：Git 面板「去设置」深链先切到本 tab，
 * 再滚动到摘要模型（见 useSettingsFocus）。
 */
export const GitTab = memo(function GitTab(props: GitTabProps) {
  const { draft, updateDraft, isDirty } = props;
  return (
    /* Git：id 供「去设置」深链滚动到摘要模型 */
    <SettingsSection id="settings-section-git" title={t("settings.git")}>
      <SettingSwitchRow
        title={t("settings.gitManagement")}
        description={t("settings.gitManagementDesc")}
        checked={draft.enableGitManagement}
        onChange={(checked) =>
          updateDraft({ enableGitManagement: checked })
        }
      />
      {draft.enableGitManagement && (
        <>
          <SettingRow
            title={
              <>
                <span>{t("settings.gitCommitMessageModel")}</span>
                <DirtyMarker dirty={isDirty("gitCommitMessageProvider") || isDirty("gitCommitMessageModel")} label={t("settings.gitCommitMessageModel")} />
              </>
            }
            description={t("settings.gitCommitMessageModelDesc")}
          >
            <Button
              variant="outline"
              className="w-full justify-start font-mono text-xs"
              onClick={props.onOpenGitModelPicker}
            >
              {draft.gitCommitMessageProvider && draft.gitCommitMessageModel
                ? `${draft.gitCommitMessageProvider}/${draft.gitCommitMessageModel}`
                : t("settings.gitCommitMessageModelUnset")}
            </Button>
          </SettingRow>
          <SettingTextarea
            title={t("settings.gitCommitMessagePrompt")}
            description={t("settings.gitCommitMessagePromptDesc")}
            value={draft.gitCommitMessagePrompt}
            onChange={(value) => updateDraft({ gitCommitMessagePrompt: value })}
          />
          {props.gitModelPickerOpen && (
            <ModelPicker
              models={props.gitModels}
              report={props.gitModelsReport}
              refreshing={props.gitModelsRefreshing}
              onRefresh={props.onRefreshGitModels}
              current={{
                provider: draft.gitCommitMessageProvider,
                modelId: draft.gitCommitMessageModel,
              }}
              favoriteModels={draft.favoriteModels ?? []}
              onClose={props.onCloseGitModelPicker}
              onPick={props.onPickGitModel}
              onToggleFavorite={props.onToggleGitModelFavorite}
            />
          )}
        </>
      )}
    </SettingsSection>
  );
});