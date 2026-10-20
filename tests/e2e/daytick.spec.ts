import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

async function register(page: Page) {
  const email = `browser-${randomUUID()}@example.com`;
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Browser-test-123!");
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Your day, made clear." }),
  ).toBeVisible();
  return email;
}

async function createTask(page: Page, title: string, minutes = "2") {
  await page.getByRole("button", { name: "Add task", exact: true }).click();
  await page.getByLabel("Task title").fill(title);
  await page.getByLabel("Planned duration (minutes)").fill(minutes);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

test("registration, CRUD, countdown persistence, completion, logout and login", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const email = await register(page);
  await createTask(page, "Read a chapter");
  await page
    .getByRole("button", { name: "Edit Read a chapter", exact: true })
    .click();
  await page.getByLabel("Task title").fill("Read two chapters");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Start countdown", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  const paused = await page.getByRole("timer").textContent();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole("timer")).toHaveText(paused!);
  await page.screenshot({
    path: `.local/dashboard-${testInfo.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Reset countdown", exact: true })
    .click();
  await expect(page.getByRole("timer")).toHaveText("02:00");
  await page
    .getByRole("button", { name: "Mark as completed", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Complete Read two chapters",
      exact: true,
    }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Browser-test-123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Delete Read two chapters", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete Read two chapters", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Delete Read two chapters", exact: true }),
  ).not.toBeVisible();
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Time Up is displayed without automatic task completion", async ({
  page,
}) => {
  await register(page);
  await createTask(page, "A brief task", "0.016666666666666666");
  await page
    .getByRole("button", { name: "Start countdown", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Time Up" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Complete A brief task", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("status").filter({ hasText: "Time Up" }),
  ).toBeVisible();
});

test("another authenticated browser cannot see private tasks", async ({
  page,
  browser,
}) => {
  await register(page);
  await createTask(page, "Private task");
  const otherContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  const other = await otherContext.newPage();
  await other.goto(page.url());
  await register(other);
  await expect(
    other.getByText("Private task", { exact: true }),
  ).not.toBeVisible();
  await expect(other.getByText("A little room for possibility.")).toBeVisible();
  await otherContext.close();
});
