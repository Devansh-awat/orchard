<script lang="ts">
</script>

<div class="od-grid">
	{#each Array(6) as _}
		<div class="card card--skel">
			<div class="card-top">
				<div class="sk sk-icon"></div>
				<div class="sk-col">
					<div class="sk" style="width:7rem;height:0.7rem"></div>
					<div class="sk" style="width:10rem;height:0.5rem"></div>
				</div>
			</div>
			<div class="card-bot">
				<div class="sk" style="width:4rem;height:0.5rem"></div>
				<div class="sk" style="width:3rem;height:0.5rem"></div>
			</div>
		</div>
	{/each}
</div>
