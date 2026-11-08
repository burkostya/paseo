import { defineTranslations } from "@getpaseo/plugin/client";

export const messages = defineTranslations({
  resources: {
    en: {
      title: "Checkpoints (example)",
      create: "Create checkpoint",
      description: "Description",
      details: "Checkpoint details",
      empty: "No checkpoints yet",
      changed: "Changed files",
      refresh: "Refresh",
    },
    ru: {
      title: "Контрольные точки (пример)",
      create: "Создать контрольную точку",
      description: "Описание",
      details: "Данные контрольной точки",
      empty: "Контрольных точек ещё нет",
      changed: "Изменённые файлы",
      refresh: "Обновить",
    },
  },
});
